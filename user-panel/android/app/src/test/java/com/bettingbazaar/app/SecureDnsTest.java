// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.net.ConnectException;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import okhttp3.Dns;

import org.junit.Test;

/**
 * The lookup policy every request of the app follows (SecureDns): encrypted
 * resolvers first, the phone's resolver only when none of them can be reached,
 * and never a lookup that leaves the player with no answer when one exists.
 * Runs on the build machine: `./gradlew testDebugUnitTest`.
 */
public class SecureDnsTest {

    private static final String HOST = "api.example.com";

    private static InetAddress ip(String literal) {
        try { return InetAddress.getByName(literal); } catch (UnknownHostException e) { throw new AssertionError(e); }
    }

    /** A resolver that records who asked and answers from a script. */
    private static final class Scripted implements Dns {
        final List<String> asked = new ArrayList<>();
        private final Object answer;   // List<InetAddress> or Exception
        Scripted(Object answer) { this.answer = answer; }

        @Override
        @SuppressWarnings("unchecked")
        public List<InetAddress> lookup(String hostname) throws UnknownHostException {
            asked.add(hostname);
            if (answer instanceof Exception) throw SecureDnsTest.<RuntimeException>sneaky((Exception) answer);
            return (List<InetAddress>) answer;
        }
    }

    /** Throws a checked exception through a signature that does not declare it, as Kotlin code does. */
    @SuppressWarnings("unchecked")
    private static <E extends Exception> E sneaky(Exception e) throws E { throw (E) e; }

    /**
     * What OkHttp's DnsOverHttps 5.5 throws when it cannot reach its server:
     * the transport's own IOException, NOT an UnknownHostException, even though
     * Dns.lookup declares only that. (5.4 wraps it in an UnknownHostException
     * instead; both shapes are tested.) Observed against a closed local port.
     */
    private static Exception unreachable() {
        return new ConnectException("Failed to connect to /1.1.1.1:443");
    }

    /** Observed from DnsOverHttps when its server answered NXDOMAIN: a bare UnknownHostException. */
    private static UnknownHostException noSuchName() {
        UnknownHostException e = new UnknownHostException();
        e.addSuppressed(new UnknownHostException());
        return e;
    }

    private static final class FakeClock implements SecureDns.Clock {
        long now = 1_000_000L;
        @Override public long now() { return now; }
    }

    private static SecureDns dns(FakeClock clock, Dns system, Dns... encrypted) {
        return new SecureDns(Arrays.asList(encrypted), system, clock);
    }

    @Test
    public void anEncryptedAnswerIsUsedAndThePhonesResolverIsNeverAsked() throws Exception {
        Scripted doh = new Scripted(Collections.singletonList(ip("203.0.113.7")));
        Scripted system = new Scripted(Collections.singletonList(ip("198.51.100.66")));
        SecureDns dns = dns(new FakeClock(), system, doh);

        assertEquals(Collections.singletonList(ip("203.0.113.7")), dns.lookup(HOST));
        assertTrue("the phone's resolver must not see the lookup", system.asked.isEmpty());
        assertEquals(SecureDns.Source.ENCRYPTED, dns.lastSource());
        assertEquals(1, dns.encryptedAnswers());
        assertEquals(0, dns.systemAnswers());
    }

    @Test
    public void theSecondEncryptedResolverIsTriedWhenTheFirstCannotBeReached() throws Exception {
        Scripted first = new Scripted(unreachable());
        Scripted second = new Scripted(Collections.singletonList(ip("203.0.113.8")));
        Scripted system = new Scripted(Collections.singletonList(ip("198.51.100.66")));
        SecureDns dns = dns(new FakeClock(), system, first, second);

        assertEquals(Collections.singletonList(ip("203.0.113.8")), dns.lookup(HOST));
        assertEquals(1, first.asked.size());
        assertTrue(system.asked.isEmpty());
        assertFalse(dns.encryptedPaused());
    }

    @Test
    public void whenNoEncryptedResolverCanBeReachedThePhonesResolverAnswersAndTheyArePaused() throws Exception {
        FakeClock clock = new FakeClock();
        Scripted first = new Scripted(unreachable());
        // Either shape of "could not reach": a bare transport exception, or one wrapped.
        UnknownHostException wrapped = new UnknownHostException(HOST);
        wrapped.initCause(new SocketTimeoutException("timeout"));
        Scripted second = new Scripted(wrapped);
        Scripted system = new Scripted(Collections.singletonList(ip("198.51.100.66")));
        SecureDns dns = dns(clock, system, first, second);

        assertEquals(Collections.singletonList(ip("198.51.100.66")), dns.lookup(HOST));
        assertEquals(SecureDns.Source.SYSTEM, dns.lastSource());
        assertTrue(dns.encryptedPaused());

        // Inside the pause: straight to the phone's resolver, no slow attempts.
        dns.lookup(HOST);
        assertEquals(1, first.asked.size());
        assertEquals(1, second.asked.size());
        assertEquals(2, system.asked.size());

        // After it: the encrypted resolvers are tried again.
        clock.now += SecureDns.ENCRYPTED_RETRY_MS;
        dns.lookup(HOST);
        assertEquals(2, first.asked.size());
    }

    @Test
    public void aNameTheEncryptedResolversDoNotKnowStillGetsTheSystemAnswerWithoutPausingThem() throws Exception {
        // Split-horizon: the public resolvers answer "no such name", the
        // network's own resolver knows it. Availability wins; TLS still checks
        // the server. The encrypted resolvers WORKED, so they are not paused.
        Scripted doh = new Scripted(noSuchName());
        Scripted empty = new Scripted(Collections.<InetAddress>emptyList());
        Scripted system = new Scripted(Collections.singletonList(ip("10.0.0.5")));
        SecureDns dns = dns(new FakeClock(), system, doh, empty);

        assertEquals(Collections.singletonList(ip("10.0.0.5")), dns.lookup("intranet.example.com"));
        assertFalse(dns.encryptedPaused());
    }

    @Test
    public void aResolverBugIsSkippedNotThrown() throws Exception {
        Scripted broken = new Scripted(new IllegalStateException("bug"));
        Scripted good = new Scripted(Collections.singletonList(ip("203.0.113.9")));
        SecureDns dns = dns(new FakeClock(), new Scripted(Collections.<InetAddress>emptyList()), broken, good);

        assertEquals(Collections.singletonList(ip("203.0.113.9")), dns.lookup(HOST));
    }

    @Test
    public void whenEverythingFailsTheSystemFailureReachesTheCaller() {
        Scripted system = new Scripted(new UnknownHostException(HOST));
        SecureDns dns = dns(new FakeClock(), system, new Scripted(unreachable()));
        try {
            dns.lookup(HOST);
            fail("expected UnknownHostException");
        } catch (UnknownHostException expected) {
            assertEquals(1, system.asked.size());
        }
    }

    @Test
    public void localhostNeverLeavesThePhone() throws Exception {
        Scripted doh = new Scripted(Collections.singletonList(ip("203.0.113.7")));
        Scripted system = new Scripted(Collections.singletonList(ip("127.0.0.1")));
        SecureDns dns = dns(new FakeClock(), system, doh);

        dns.lookup("localhost");
        dns.lookup("LOCALHOST");
        assertTrue(doh.asked.isEmpty());
        assertEquals(2, system.asked.size());
    }

    @Test
    public void onlyATransportCauseCountsAsUnreachable() {
        UnknownHostException wrapped = new UnknownHostException(HOST);
        wrapped.initCause(new ConnectException("refused"));
        assertTrue(SecureDns.couldNotReach(wrapped));
        assertFalse(SecureDns.couldNotReach(noSuchName()));
        UnknownHostException nested = new UnknownHostException(HOST);
        nested.initCause(new UnknownHostException("inner"));
        assertFalse(SecureDns.couldNotReach(nested));
        UnknownHostException suppressed = new UnknownHostException(HOST);
        suppressed.addSuppressed(new ConnectException("refused"));
        assertTrue(SecureDns.couldNotReach(suppressed));
    }
}
