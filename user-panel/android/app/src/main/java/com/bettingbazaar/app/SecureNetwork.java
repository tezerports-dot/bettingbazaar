// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

/**
 * SecureNetwork — the one HTTP client the app's native side owns (CLAUDE.md §2,
 * "How the player app reaches the network").
 *
 * Every request the app makes goes out through {@link #client()}: the web
 * screens' API calls and live-updates stream (via {@link SecureHttpPlugin}) and
 * the update download ({@link ApkUpdaterPlugin}). They all share
 * {@link SecureDns}, so the hostname of the API, the discovery URL, the gateway
 * mirrors, the upload store and the update CDN are resolved the same way.
 *
 * TLS is the platform's and is never relaxed here: no custom trust manager, no
 * hostname-verifier override, and the OS refuses cleartext for this app
 * (network_security_config.xml applies to OkHttp on Android too).
 */
public final class SecureNetwork {

    /**
     * The encrypted resolvers, tried in order. Each is reached at a fixed
     * address (its "bootstrap"), so finding the resolver never needs the phone's
     * DNS. Two operators, so one being blocked or down is not a fallback.
     */
    private static final String[][] RESOLVERS = {
        { "https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001" },
        { "https://dns.google/dns-query", "8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844" },
    };

    /**
     * One encrypted lookup is given this long before the next resolver is
     * tried. Short: on a network that silently drops these addresses the
     * player waits this once per resolver, then {@link SecureDns} stops asking.
     */
    private static final long RESOLVER_TIMEOUT_MS = 3_000L;

    private static volatile SecureNetwork instance;

    public static SecureNetwork get() {
        SecureNetwork n = instance;
        if (n == null) {
            synchronized (SecureNetwork.class) {
                n = instance;
                if (n == null) instance = n = new SecureNetwork();
            }
        }
        return n;
    }

    private final SecureDns dns;
    private final OkHttpClient client;

    private SecureNetwork() {
        OkHttpClient resolverClient = new OkHttpClient.Builder()
            .connectTimeout(RESOLVER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(RESOLVER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(RESOLVER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build();

        List<Dns> encrypted = new ArrayList<>();
        for (String[] r : RESOLVERS) {
            encrypted.add(new DnsOverHttps.Builder()
                .client(resolverClient)
                .url(HttpUrl.get(r[0]))
                .bootstrapDnsHosts(addresses(Arrays.copyOfRange(r, 1, r.length)))
                // Our hosts are public; a public resolver naming a private
                // address for them is a rebinding attempt, not an answer.
                .resolvePrivateAddresses(false)
                .build());
        }
        dns = new SecureDns(encrypted, Dns.SYSTEM, System::currentTimeMillis);

        client = new OkHttpClient.Builder()
            .dns(dns)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            // Never follow an https link onto http, even if the OS would allow it.
            .followSslRedirects(false)
            .build();
    }

    /** The shared client: one connection pool, one resolver. Derive per-call variants with newBuilder(). */
    public OkHttpClient client() { return client; }

    public SecureDns dns() { return dns; }

    private static List<InetAddress> addresses(String[] literals) {
        List<InetAddress> out = new ArrayList<>();
        for (String ip : literals) {
            try {
                // A literal address: parsed, never looked up.
                out.add(InetAddress.getByName(ip));
            } catch (UnknownHostException ignored) {
                // Not reachable for a literal; skip rather than fail startup.
            }
        }
        return out;
    }
}
