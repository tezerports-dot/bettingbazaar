// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.Dns;

/**
 * SecureDns — how the app turns a hostname into an address (CLAUDE.md §2,
 * "How the player app reaches the network").
 *
 * The policy, in order:
 *
 *   1. Ask each encrypted resolver (DNS-over-HTTPS) in turn. The first one that
 *      answers with addresses wins. The phone's Wi-Fi or carrier DNS is never
 *      asked, so it can neither see nor rewrite which host the app looks up.
 *   2. If NONE of them could be reached (the network blocks them, a captive
 *      portal, no route), fall back to the phone's own resolver for this lookup
 *      and stop trying the encrypted ones for {@link #ENCRYPTED_RETRY_MS}, so a
 *      network that drops them costs one slow lookup, not one per request.
 *   3. If an encrypted resolver was reached but had no address for the name,
 *      the phone's resolver is still asked (split-horizon and corporate DNS
 *      legitimately know names the public resolvers do not), but the encrypted
 *      resolvers are NOT backed off: they are working.
 *
 * Why falling back is safe: every request this app makes is TLS with the
 * system's certificate authorities, and cleartext is refused by the OS
 * (res/xml/network_security_config.xml). An address handed out by a hostile
 * resolver leads to a server that cannot show our certificate, so the
 * connection is refused before a byte of the request is sent. Encrypted DNS
 * is the extra layer that keeps the lookup private and untampered on the way;
 * the certificate check is still the guarantee. Never "fail closed" here: a
 * player locked out on a network that blocks 1.1.1.1 is an outage, not safety.
 *
 * Pure Java over {@link Dns} so the policy is unit-tested on the build machine
 * (SecureDnsTest) with no network.
 */
public final class SecureDns implements Dns {

    /** After every encrypted resolver failed to answer, how long the phone's resolver is used alone. */
    public static final long ENCRYPTED_RETRY_MS = 5 * 60_000L;

    /** Where the last answer came from, for {@link SecureHttpPlugin#status}. */
    public enum Source { NONE, ENCRYPTED, SYSTEM }

    /** Injected so the back-off is testable without sleeping. */
    public interface Clock { long now(); }

    private final List<Dns> encrypted;
    private final Dns system;
    private final Clock clock;

    private volatile long encryptedPausedUntil = 0L;
    private volatile Source lastSource = Source.NONE;
    private final AtomicLong encryptedAnswers = new AtomicLong();
    private final AtomicLong systemAnswers = new AtomicLong();

    public SecureDns(List<Dns> encrypted, Dns system, Clock clock) {
        this.encrypted = Collections.unmodifiableList(new ArrayList<>(encrypted));
        this.system = system;
        this.clock = clock;
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        if (isLocal(hostname)) return system.lookup(hostname);

        if (clock.now() >= encryptedPausedUntil) {
            boolean anyReached = false;
            for (Dns resolver : encrypted) {
                try {
                    List<InetAddress> found = resolver.lookup(hostname);
                    if (found != null && !found.isEmpty()) {
                        encryptedAnswers.incrementAndGet();
                        lastSource = Source.ENCRYPTED;
                        return found;
                    }
                    anyReached = true;   // answered, with nothing
                } catch (Exception e) {
                    // Declared or not (OkHttp is Kotlin), a resolver throws a
                    // plain IOException such as ConnectException when it cannot
                    // be reached, and UnknownHostException when it answered "no
                    // such name". A RuntimeException is a resolver bug: skipped,
                    // never allowed to take the app's networking down.
                    if (e instanceof UnknownHostException && !couldNotReach((UnknownHostException) e)) anyReached = true;
                }
            }
            if (!anyReached && !encrypted.isEmpty()) encryptedPausedUntil = clock.now() + ENCRYPTED_RETRY_MS;
        }

        List<InetAddress> found = system.lookup(hostname);
        systemAnswers.incrementAndGet();
        lastSource = Source.SYSTEM;
        return found;
    }

    /**
     * For an UnknownHostException: true when it wraps a failure getting TO the
     * resolver (connect, TLS, timeout) rather than the resolver answering that
     * the name has no address.
     */
    static boolean couldNotReach(UnknownHostException e) {
        for (Throwable t = e.getCause(); t != null && t != t.getCause(); t = t.getCause()) {
            if (t instanceof IOException && !(t instanceof UnknownHostException)) return true;
        }
        for (Throwable s : e.getSuppressed()) {
            if (s instanceof IOException && !(s instanceof UnknownHostException)) return true;
        }
        return false;
    }

    /** Names that never leave the phone. */
    static boolean isLocal(String hostname) {
        String h = hostname == null ? "" : hostname.toLowerCase(Locale.ROOT);
        return h.equals("localhost") || h.endsWith(".localhost");
    }

    public boolean encryptedPaused() { return clock.now() < encryptedPausedUntil; }
    public Source lastSource() { return lastSource; }
    public long encryptedAnswers() { return encryptedAnswers.get(); }
    public long systemAnswers() { return systemAnswers.get(); }
}
