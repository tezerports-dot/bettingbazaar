// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import mockwebserver3.MockResponse;
import mockwebserver3.MockWebServer;
import mockwebserver3.RecordedRequest;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;
import okio.Buffer;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * SecureTransport + DohDns against real sockets: a TLS "API" on 127.0.0.1 that
 * is reachable as api.example.com ONLY because the fake DoH server says so.
 * `./gradlew testDebugUnitTest`.
 */
public class SecureTransportTest {

    private static final String HOST = "api.example.com";

    private FakeDoh doh;
    private MockWebServer api;
    private HandshakeCertificates clientCerts;
    private final List<Cookie> jarCookies = new CopyOnWriteArrayList<>();

    private final CookieJar jar = new CookieJar() {
        @Override public void saveFromResponse(HttpUrl url, List<Cookie> cookies) { jarCookies.addAll(cookies); }
        @Override public List<Cookie> loadForRequest(HttpUrl url) { return new ArrayList<>(jarCookies); }
    };

    @Before
    public void setUp() throws Exception {
        doh = new FakeDoh().map(HOST, 127, 0, 0, 1);
        HeldCertificate cert = new HeldCertificate.Builder().addSubjectAlternativeName(HOST).build();
        HandshakeCertificates serverCerts = new HandshakeCertificates.Builder().heldCertificate(cert).build();
        clientCerts = new HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate()).build();
        api = new MockWebServer();
        api.useHttps(serverCerts.sslSocketFactory());
        // HTTP/1.1, so a chunked body is chunked and Host is a header (under
        // HTTP/2 it is the :authority pseudo-header).
        api.setProtocols(Arrays.asList(Protocol.HTTP_1_1));
        api.start(java.net.InetAddress.getByName("127.0.0.1"), 0);
    }

    @After
    public void tearDown() throws Exception {
        api.close();
        doh.close();
    }

    /** A plain client (no proxy: the build machine may set one globally). */
    private OkHttpClient plain() {
        return new OkHttpClient.Builder().proxy(Proxy.NO_PROXY).build();
    }

    private SecureTransport transport(Dns... providers) {
        OkHttpClient.Builder start = plain().newBuilder()
            .sslSocketFactory(clientCerts.sslSocketFactory(), clientCerts.trustManager());
        DohDns dns = new DohDns(providers.length > 0 ? Arrays.asList(providers) : Arrays.asList(doh.provider(plain())));
        return new SecureTransport(SecureTransport.clientBuilder(start, dns, jar).build());
    }

    private String url(String path) {
        return "https://" + HOST + ":" + api.getPort() + path;
    }

    private static final class Outcome {
        SecureTransport.Result result;
        IOException error;
        boolean cancelled;
    }

    private static Outcome run(SecureTransport t, String id, SecureTransport.Spec spec) throws Exception {
        CompletableFuture<Outcome> f = new CompletableFuture<>();
        t.execute(id, spec, new SecureTransport.ResultCallback() {
            @Override public void onResult(SecureTransport.Result r) { Outcome o = new Outcome(); o.result = r; f.complete(o); }
            @Override public void onFailure(IOException e, boolean cancelled) { Outcome o = new Outcome(); o.error = e; o.cancelled = cancelled; f.complete(o); }
        });
        return f.get(10, TimeUnit.SECONDS);
    }

    private SecureTransport.Spec get(String path) {
        SecureTransport.Spec s = new SecureTransport.Spec();
        s.url = url(path);
        return s;
    }

    private static boolean causedBy(Throwable e, Class<?> type) {
        for (Throwable t = e; t != null; t = t.getCause()) if (type.isInstance(t)) return true;
        return false;
    }

    // ── Name resolution ─────────────────────────────────────────────────────

    @Test
    public void resolvesTheHostOverDohAndReachesIt() throws Exception {
        api.enqueue(new MockResponse.Builder().body("{\"ok\":true}").setHeader("Content-Type", "application/json").build());
        Outcome o = run(transport(), "a", get("/api/v1/boards"));
        assertNull(o.error);
        assertEquals(200, o.result.status);
        assertEquals("{\"ok\":true}", new String(o.result.body, StandardCharsets.UTF_8));
        assertTrue("the DoH server was asked for the API host", doh.asked.contains(HOST));
        assertEquals("/api/v1/boards", api.takeRequest(5, TimeUnit.SECONDS).getTarget());
    }

    @Test
    public void aHostDohCannotResolveFailsWithNoFallbackToSystemDns() throws Exception {
        // localhost is resolvable by any system resolver; DoH is not asked for
        // it (no public suffix) and system DNS is refused, so it must fail.
        SecureTransport.Spec s = new SecureTransport.Spec();
        s.url = "https://localhost:" + api.getPort() + "/x";
        Outcome o = run(transport(), "b", s);
        assertNotNull(o.error);
        assertTrue(causedBy(o.error, UnknownHostException.class));
        assertEquals(0, api.getRequestCount());

        // An unknown public name: NXDOMAIN from DoH, nothing sent.
        SecureTransport.Spec t = new SecureTransport.Spec();
        t.url = "https://unknown.example.com:" + api.getPort() + "/x";
        Outcome p = run(transport(), "c", t);
        assertTrue(causedBy(p.error, UnknownHostException.class));
        assertTrue(doh.asked.contains("unknown.example.com"));
        assertEquals(0, api.getRequestCount());
    }

    @Test
    public void theSecondProviderAnswersWhenTheFirstFails() throws Exception {
        try (FakeDoh broken = new FakeDoh()) {
            broken.failWithStatus = 503;
            api.enqueue(new MockResponse.Builder().body("ok").build());
            Outcome o = run(transport(broken.provider(plain()), doh.provider(plain())), "d", get("/ok"));
            assertNull(o.error);
            assertEquals(200, o.result.status);
            assertTrue("the broken provider was tried first", broken.server.getRequestCount() > 0);
        }
    }

    @Test
    public void everyProviderFailingFailsTheLookup() throws Exception {
        doh.failWithStatus = 500;
        Outcome o = run(transport(), "e", get("/x"));
        assertTrue(causedBy(o.error, UnknownHostException.class));
        assertEquals(0, api.getRequestCount());
    }

    @Test
    public void theResolverItselfIsNeverFoundThroughSystemDns() throws Exception {
        // A provider named by hostname with no fixed address: the system
        // resolver would find "localhost" (where FakeDoh listens) at once, so
        // this resolves ONLY if system DNS leaked in.
        Dns byName = DohDns.provider(plain(), "http://localhost:" + doh.server.getPort() + "/dns-query");
        try {
            new DohDns(Arrays.asList(byName)).lookup(HOST);
            fail("the DoH server's own name must not be resolved by system DNS");
        } catch (UnknownHostException expected) {
            assertTrue(doh.asked.isEmpty());
        }
    }

    @Test
    public void ipLiteralsAreNotLookedUp() throws Exception {
        DohDns dns = new DohDns(Arrays.asList(doh.provider(plain())));
        assertEquals("127.0.0.1", dns.lookup("127.0.0.1").get(0).getHostAddress());
        assertTrue(DohDns.isIpLiteral("::1"));
        assertFalse(DohDns.isIpLiteral("api.example.com"));
        assertTrue(doh.asked.isEmpty());
    }

    // ── What the page may send, and what it sees ────────────────────────────

    @Test
    public void refusesPlaintextBeforeSendingAnything() throws Exception {
        SecureTransport.Spec s = new SecureTransport.Spec();
        s.url = "http://" + HOST + ":" + api.getPort() + "/x";
        Outcome o = run(transport(), "f", s);
        assertNotNull(o.error);
        assertTrue(o.error.getMessage().contains("https"));
        assertTrue(doh.asked.isEmpty());
    }

    @Test
    public void forwardsThePagesHeadersAndBodyButNotTheOnesTheClientOwns() throws Exception {
        api.enqueue(new MockResponse.Builder().code(201).body("done").build());
        SecureTransport.Spec s = get("/api/bet/place");
        s.method = "post";
        s.headers.add(new String[] { "Content-Type", "application/json" });
        s.headers.add(new String[] { "Authorization", "Bearer t0k" });
        s.headers.add(new String[] { "Origin", "https://localhost" });
        s.headers.add(new String[] { "Cookie", "auth_token=forged" });
        s.headers.add(new String[] { "Host", "evil.example" });
        s.headers.add(new String[] { "Content-Length", "1" });
        byte[] body = new byte[] { '{', '}', (byte) 0xff, 0 };
        s.body = body;
        Outcome o = run(transport(), "g", s);
        assertNull(o.error);
        assertEquals(201, o.result.status);

        RecordedRequest r = api.takeRequest(5, TimeUnit.SECONDS);
        assertEquals("POST", r.getMethod());
        assertEquals("application/json", r.getHeaders().get("Content-Type"));
        assertEquals("Bearer t0k", r.getHeaders().get("Authorization"));
        assertEquals("https://localhost", r.getHeaders().get("Origin"));
        assertNull("no cookie the page wrote, and none from the jar without include", r.getHeaders().get("Cookie"));
        assertEquals(HOST + ":" + api.getPort(), r.getHeaders().get("Host"));
        assertArrayEquals(body, r.getBody().toByteArray());
    }

    @Test
    public void cookiesMoveOnlyWithCredentialsIncludeAndAreNeverShownToThePage() throws Exception {
        api.enqueue(new MockResponse.Builder().addHeader("Set-Cookie", "auth_token=abc; Path=/; Secure; HttpOnly").body("x").build());
        Outcome omit = run(transport(), "h1", get("/login"));
        assertTrue("credentials not included: nothing stored", jarCookies.isEmpty());
        for (String[] h : omit.result.headers) assertFalse(h[0].equalsIgnoreCase("set-cookie"));

        api.enqueue(new MockResponse.Builder().addHeader("Set-Cookie", "auth_token=abc; Path=/; Secure; HttpOnly").body("x").build());
        SecureTransport.Spec inc = get("/login");
        inc.sendCookies = true;
        Outcome in = run(transport(), "h2", inc);
        assertEquals(1, jarCookies.size());
        for (String[] h : in.result.headers) assertFalse(h[0].equalsIgnoreCase("set-cookie"));

        api.enqueue(new MockResponse.Builder().body("y").build());
        api.enqueue(new MockResponse.Builder().body("z").build());
        SecureTransport.Spec withCookie = get("/me");
        withCookie.sendCookies = true;
        run(transport(), "h3", withCookie);
        run(transport(), "h4", get("/public"));
        api.takeRequest(5, TimeUnit.SECONDS);
        api.takeRequest(5, TimeUnit.SECONDS);
        assertEquals("auth_token=abc", api.takeRequest(5, TimeUnit.SECONDS).getHeaders().get("Cookie"));
        assertNull(api.takeRequest(5, TimeUnit.SECONDS).getHeaders().get("Cookie"));
    }

    // ── Redirects ───────────────────────────────────────────────────────────

    @Test
    public void redirectErrorRefusesAnyRedirect() throws Exception {
        api.enqueue(new MockResponse.Builder().code(302).setHeader("Location", "/elsewhere").build());
        SecureTransport.Spec s = get("/health/live");
        s.followRedirects = false;
        Outcome o = run(transport(), "i", s);
        assertNotNull(o.error);
        assertEquals(1, api.getRequestCount());
    }

    @Test
    public void followsASameSchemeRedirectAndReportsIt() throws Exception {
        api.enqueue(new MockResponse.Builder().code(302).setHeader("Location", "/final").build());
        api.enqueue(new MockResponse.Builder().body("here").build());
        Outcome o = run(transport(), "j", get("/start"));
        assertNull(o.error);
        assertTrue(o.result.redirected);
        assertTrue(o.result.url.endsWith("/final"));
    }

    @Test
    public void neverFollowsARedirectOffTls() throws Exception {
        try (MockWebServer plainServer = new MockWebServer()) {
            plainServer.start(java.net.InetAddress.getByName("127.0.0.1"), 0);
            plainServer.enqueue(new MockResponse.Builder().body("cleartext").build());
            api.enqueue(new MockResponse.Builder().code(302)
                .setHeader("Location", "http://" + HOST + ":" + plainServer.getPort() + "/plain").build());
            Outcome o = run(transport(), "k", get("/start"));
            assertNotNull(o.error);
            assertEquals(1, api.getRequestCount());
            assertEquals("nothing was sent in the clear", 0, plainServer.getRequestCount());
        }
    }

    // ── Cancellation and streams ────────────────────────────────────────────

    @Test
    public void cancelAbortsARunningRequest() throws Exception {
        api.enqueue(new MockResponse.Builder().body("late").headersDelay(5, TimeUnit.SECONDS).build());
        SecureTransport t = transport();
        CompletableFuture<Outcome> f = new CompletableFuture<>();
        t.execute("slow", get("/slow"), new SecureTransport.ResultCallback() {
            @Override public void onResult(SecureTransport.Result r) { Outcome o = new Outcome(); o.result = r; f.complete(o); }
            @Override public void onFailure(IOException e, boolean cancelled) { Outcome o = new Outcome(); o.error = e; o.cancelled = cancelled; f.complete(o); }
        });
        api.takeRequest(5, TimeUnit.SECONDS);
        t.cancel("slow");
        Outcome o = f.get(5, TimeUnit.SECONDS);
        assertNotNull(o.error);
        assertTrue(o.cancelled);
    }

    private static final class StreamLog implements SecureTransport.StreamListener {
        final CompletableFuture<SecureTransport.Result> opened = new CompletableFuture<>();
        final StringBuilder text = new StringBuilder();
        final CompletableFuture<IOException> ended = new CompletableFuture<>();
        @Override public void onOpen(SecureTransport.Result head) { opened.complete(head); }
        @Override public synchronized void onData(String t) { text.append(t); }
        @Override public void onEnd(IOException error) { ended.complete(error); }
    }

    @Test
    public void streamsServerSentEventsAsText() throws Exception {
        String events = "retry: 3000\n\nevent: pool_update\ndata: {\"total\":\"₹1\"}\n\n: ping\n\n";
        api.enqueue(new MockResponse.Builder()
            .setHeader("Content-Type", "text/event-stream; charset=utf-8")
            .chunkedBody(new Buffer().writeUtf8(events), 7)
            .build());
        StreamLog log = new StreamLog();
        transport().openStream("s1", get("/api/sse/events"), log);
        assertEquals(200, log.opened.get(5, TimeUnit.SECONDS).status);
        assertNull(log.ended.get(5, TimeUnit.SECONDS));
        assertEquals(events, log.text.toString());
    }

    @Test
    public void aRefusedStreamOpensWithItsStatusAndCarriesNoData() throws Exception {
        api.enqueue(new MockResponse.Builder().code(401).body("{\"error\":\"no\"}").build());
        StreamLog log = new StreamLog();
        transport().openStream("s2", get("/api/sse/player/events"), log);
        assertEquals(401, log.opened.get(5, TimeUnit.SECONDS).status);
        assertNull(log.ended.get(5, TimeUnit.SECONDS));
        assertEquals("", log.text.toString());
    }

    @Test
    public void aCancelledStreamReportsNothingMore() throws Exception {
        api.enqueue(new MockResponse.Builder()
            .setHeader("Content-Type", "text/event-stream")
            .body("data: 1\n\n")
            .bodyDelay(3, TimeUnit.SECONDS)
            .build());
        StreamLog log = new StreamLog();
        SecureTransport t = transport();
        t.openStream("s3", get("/api/sse/events"), log);
        log.opened.get(5, TimeUnit.SECONDS);
        t.cancel("s3");
        try {
            log.ended.get(1500, TimeUnit.MILLISECONDS);
            fail("no end is reported after the page closed the stream");
        } catch (java.util.concurrent.TimeoutException expected) {
            // the page closed it; it hears nothing more
        }
    }

    @Test
    public void aStreamCancelledBeforeItOpensReportsNothing() throws Exception {
        api.enqueue(new MockResponse.Builder()
            .setHeader("Content-Type", "text/event-stream")
            .body("data: 1\n\n")
            .headersDelay(3, TimeUnit.SECONDS)
            .build());
        StreamLog log = new StreamLog();
        SecureTransport t = transport();
        t.openStream("s4", get("/api/sse/events"), log);
        api.takeRequest(5, TimeUnit.SECONDS);
        t.cancel("s4");
        try {
            log.ended.get(1500, TimeUnit.MILLISECONDS);
            fail("no end is reported after the page closed the stream");
        } catch (java.util.concurrent.TimeoutException expected) {
            assertFalse(log.opened.isDone());
        }
    }

    @Test
    public void downloadRefusesPlaintext() {
        try {
            transport().download("http://" + HOST + "/app.apk", 1000).close();
            fail("plaintext download must be refused");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("https"));
        }
    }
}
