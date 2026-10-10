// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.io.IOException;
import java.io.Reader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.CookieJar;
import okhttp3.Dns;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * SecureTransport — the one way this app's network requests leave the phone
 * (CLAUDE.md §2 "How the Android app reaches the network").
 *
 * The web bundle's fetch() and EventSource are routed here by
 * user-panel/src/services/secureTransport.ts through SecureHttpPlugin, so every
 * request is resolved by DohDns instead of the WebView's own resolver. It keeps
 * the browser's rules where they matter:
 *
 *   - TLS only. A non-https URL is refused before anything is sent, and an
 *     https → http redirect is never followed (followSslRedirects false).
 *   - Cookies only when the page asked for them (`credentials: 'include'`),
 *     from the same jar the WebView uses (WebViewCookieJar), and never handed
 *     to the page: Set-Cookie and Set-Cookie2 are stripped from what it sees.
 *   - Headers the browser owns (Host, Cookie, Content-Length, Accept-Encoding,
 *     Connection…) are never taken from the page.
 *
 * Pure Java over OkHttp, so it is unit-tested on the build machine
 * (SecureTransportTest), with no Android or Capacitor types.
 */
public final class SecureTransport {

    /** What the page asked for. */
    public static final class Spec {
        public String method = "GET";
        public String url;
        public final List<String[]> headers = new ArrayList<>();
        public byte[] body;
        /** false = redirect: 'error' (a 3xx fails the request). */
        public boolean followRedirects = true;
        /** credentials: 'include'. Anything else sends and stores no cookie. */
        public boolean sendCookies = false;
        /** 0 = no overall deadline (the page's own AbortSignal still applies). */
        public long timeoutMs = 0;
    }

    /** What the page gets back. */
    public static final class Result {
        public int status;
        public String statusText;
        public final List<String[]> headers = new ArrayList<>();
        public byte[] body;
        public String url;
        public boolean redirected;
    }

    public interface ResultCallback {
        void onResult(Result result);
        /** Network failure, refusal or cancellation; {@code cancelled} when the page aborted. */
        void onFailure(IOException error, boolean cancelled);
    }

    public interface StreamListener {
        void onOpen(Result head);
        void onData(String text);
        /** {@code error} null = the server ended the stream. Not called after cancel(). */
        void onEnd(IOException error);
    }

    /** Lower-case names the page may not set; OkHttp or the cookie jar owns them. */
    static final Set<String> FORBIDDEN_REQUEST_HEADERS = Collections.unmodifiableSet(new HashSet<>(java.util.Arrays.asList(
        "host", "connection", "keep-alive", "content-length", "transfer-encoding", "te",
        "trailer", "upgrade", "accept-encoding", "cookie", "cookie2", "proxy-authorization",
        "proxy-connection")));

    /** Lower-case names the page never sees, as in a browser. */
    static final Set<String> HIDDEN_RESPONSE_HEADERS = Collections.unmodifiableSet(new HashSet<>(java.util.Arrays.asList(
        "set-cookie", "set-cookie2")));

    private final OkHttpClient base;
    private final Map<String, Call> inFlight = new ConcurrentHashMap<>();

    /** {@code base} carries the DNS and the cookie jar; see {@link #clientBuilder}. */
    public SecureTransport(OkHttpClient base) {
        this.base = base;
    }

    /**
     * The client every request derives from. {@code dns} is DohDns in the app;
     * a test passes its own. Redirects across schemes are never followed.
     */
    public static OkHttpClient.Builder clientBuilder(OkHttpClient.Builder start, Dns dns, CookieJar cookies) {
        return start
            .dns(dns)
            .cookieJar(cookies)
            .followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS);
    }

    public OkHttpClient client() {
        return base;
    }

    /** Runs {@code spec}; exactly one callback method is called. */
    public void execute(String id, Spec spec, ResultCallback cb) {
        final Request request;
        try {
            request = build(spec);
        } catch (IOException e) {
            cb.onFailure(e, false);
            return;
        }
        OkHttpClient.Builder b = base.newBuilder().followRedirects(spec.followRedirects);
        if (!spec.sendCookies) b.cookieJar(CookieJar.NO_COOKIES);
        if (spec.timeoutMs > 0) b.callTimeout(spec.timeoutMs, TimeUnit.MILLISECONDS);
        Call call = b.build().newCall(request);
        track(id, call);
        call.enqueue(new Callback() {
            @Override public void onFailure(Call c, IOException e) {
                untrack(id, c);
                cb.onFailure(e, c.isCanceled());
            }

            @Override public void onResponse(Call c, Response response) {
                try (Response r = response) {
                    if (!spec.followRedirects && r.isRedirect()) {
                        throw new IOException("Redirect refused (redirect: 'error')");
                    }
                    if (spec.followRedirects && r.isRedirect()) {
                        // Only a scheme-changing redirect is left unfollowed.
                        throw new IOException("Redirect to a non-TLS address refused");
                    }
                    Result out = head(r, request);
                    ResponseBody body = r.body();
                    out.body = body == null ? new byte[0] : body.bytes();
                    untrack(id, c);
                    cb.onResult(out);
                } catch (IOException e) {
                    untrack(id, c);
                    cb.onFailure(e, c.isCanceled());
                }
            }
        });
    }

    /**
     * Opens a long-lived stream (server-sent events). The body is delivered as
     * text, in whatever pieces it arrives; the caller parses it.
     */
    public void openStream(String id, Spec spec, StreamListener listener) {
        final Request request;
        try {
            request = build(spec);
        } catch (IOException e) {
            listener.onEnd(e);
            return;
        }
        OkHttpClient.Builder b = base.newBuilder()
            .followRedirects(spec.followRedirects)
            .readTimeout(0, TimeUnit.MILLISECONDS)   // a stream may be quiet between events
            .callTimeout(0, TimeUnit.MILLISECONDS);
        if (!spec.sendCookies) b.cookieJar(CookieJar.NO_COOKIES);
        Call call = b.build().newCall(request);
        track(id, call);
        call.enqueue(new Callback() {
            @Override public void onFailure(Call c, IOException e) {
                untrack(id, c);
                if (!c.isCanceled()) listener.onEnd(e);
            }

            @Override public void onResponse(Call c, Response response) {
                try (Response r = response) {
                    if (r.isRedirect()) throw new IOException("Redirect refused");
                    listener.onOpen(head(r, request));
                    ResponseBody body = r.body();
                    if (r.isSuccessful() && body != null) {
                        try (Reader in = body.charStream()) {
                            char[] buf = new char[8192];
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                if (n > 0) listener.onData(new String(buf, 0, n));
                            }
                        }
                    }
                    untrack(id, c);
                    if (!c.isCanceled()) listener.onEnd(null);
                } catch (IOException e) {
                    untrack(id, c);
                    if (!c.isCanceled()) listener.onEnd(e);
                }
            }
        });
    }

    /** Aborts the request or stream with this id, if it is still running. */
    public void cancel(String id) {
        Call call = inFlight.remove(id);
        if (call != null) call.cancel();
    }

    /** Opens a raw download over the same client (no cookies); the caller closes the response. */
    public Response download(String url, long timeoutMs) throws IOException {
        Spec s = new Spec();
        s.url = url;
        Request request = build(s);
        OkHttpClient.Builder b = base.newBuilder().cookieJar(CookieJar.NO_COOKIES);
        if (timeoutMs > 0) b.readTimeout(timeoutMs, TimeUnit.MILLISECONDS);
        Response r = b.build().newCall(request).execute();
        if (!"https".equals(r.request().url().scheme())) {
            r.close();
            throw new IOException("Download redirected off TLS");
        }
        return r;
    }

    static Request build(Spec spec) throws IOException {
        HttpUrl url = spec.url == null ? null : HttpUrl.parse(spec.url);
        if (url == null) throw new IOException("Not a valid URL");
        if (!"https".equals(url.scheme())) throw new IOException("Only https:// addresses are allowed");

        String method = spec.method == null ? "GET" : spec.method.toUpperCase(Locale.ROOT);
        Request.Builder rb = new Request.Builder().url(url);
        for (String[] h : spec.headers) {
            if (h == null || h.length < 2 || h[0] == null || h[1] == null) continue;
            String name = h[0].trim();
            if (name.isEmpty() || FORBIDDEN_REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))) continue;
            if (name.toLowerCase(Locale.ROOT).startsWith("proxy-") || name.toLowerCase(Locale.ROOT).startsWith("sec-")) continue;
            try {
                rb.addHeader(name, h[1]);
            } catch (IllegalArgumentException e) {
                throw new IOException("Invalid header " + name, e);
            }
        }

        RequestBody body = null;
        boolean permitsBody = !("GET".equals(method) || "HEAD".equals(method));
        boolean requiresBody = "POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method);
        if (permitsBody) {
            byte[] bytes = spec.body == null ? new byte[0] : spec.body;
            // No media type: the page's own Content-Type header stays as sent.
            body = (spec.body != null || requiresBody) ? RequestBody.create(bytes, (MediaType) null) : null;
        } else if (spec.body != null && spec.body.length > 0) {
            throw new IOException(method + " cannot carry a body");
        }
        rb.method(method, body);
        return rb.build();
    }

    static Result head(Response r, Request sent) {
        Result out = new Result();
        out.status = r.code();
        out.statusText = r.message();
        out.url = r.request().url().toString();
        out.redirected = !r.request().url().equals(sent.url());
        Headers hs = r.headers();
        for (int i = 0; i < hs.size(); i++) {
            if (HIDDEN_RESPONSE_HEADERS.contains(hs.name(i).toLowerCase(Locale.ROOT))) continue;
            out.headers.add(new String[] { hs.name(i), hs.value(i) });
        }
        return out;
    }

    private void track(String id, Call call) {
        if (id == null) return;
        Call old = inFlight.put(id, call);
        if (old != null && old != call) old.cancel();
    }

    private void untrack(String id, Call call) {
        if (id != null) inFlight.remove(id, call);
    }
}
