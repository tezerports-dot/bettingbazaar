// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

/**
 * DohDns — every hostname this app connects to is looked up over HTTPS
 * (DNS-over-HTTPS), never through the phone's own resolver (owner, 2026-10-10;
 * CLAUDE.md §2 "How the Android app reaches the network").
 *
 * Providers are asked in order: Cloudflare, then Google. Each is reached by a
 * FIXED IP address (the bootstrap list), so finding the resolver itself needs no
 * plain DNS either. A provider that fails or answers nothing hands over to the
 * next; when every provider fails the lookup fails. There is deliberately no
 * fall back to the carrier or Wi-Fi resolver: that is the path this exists to
 * avoid, and a fallback would let anyone who can block the two providers
 * switch the app back onto it.
 *
 * What this protects and what it does not (DECISION_LOG 2026-10-10): the local
 * network can no longer read or rewrite which host the app looks up. The
 * answer itself is as trustworthy as the provider; TLS certificate checking is
 * still what proves the server is ours.
 *
 * Pure Java over OkHttp, so it is unit-tested on the build machine
 * (DohDnsTest). Used through SecureNetwork.
 */
public final class DohDns implements Dns {

    /** The system resolver is never consulted; a host DoH will not answer fails. */
    static final Dns REFUSE_SYSTEM_DNS = hostname -> {
        throw new UnknownHostException("System DNS is disabled; " + hostname + " is resolved over HTTPS only");
    };

    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    private final List<Dns> providers;

    DohDns(List<Dns> providers) {
        if (providers.isEmpty()) throw new IllegalArgumentException("at least one DoH provider");
        this.providers = Collections.unmodifiableList(new ArrayList<>(providers));
    }

    /** Cloudflare (1.1.1.1), then Google (8.8.8.8), over the given client. */
    public static DohDns standard(OkHttpClient bootstrap) {
        List<Dns> list = new ArrayList<>();
        list.add(provider(bootstrap, "https://cloudflare-dns.com/dns-query",
            "1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"));
        list.add(provider(bootstrap, "https://dns.google/dns-query",
            "8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"));
        return new DohDns(list);
    }

    static Dns provider(OkHttpClient bootstrap, String url, String... bootstrapIps) {
        List<InetAddress> ips = new ArrayList<>();
        for (String ip : bootstrapIps) {
            try {
                ips.add(InetAddress.getByName(ip)); // a literal: parsed, never looked up
            } catch (UnknownHostException e) {
                throw new IllegalArgumentException("bad bootstrap address " + ip, e);
            }
        }
        DnsOverHttps.Builder b = new DnsOverHttps.Builder()
            .client(bootstrap)
            .url(HttpUrl.get(url))
            .includeIPv6(true)
            // A name with no public suffix ("localhost", "router") is not sent
            // to a public resolver; with system DNS refused it simply fails.
            .resolvePrivateAddresses(false)
            .systemDns(REFUSE_SYSTEM_DNS);
        if (!ips.isEmpty()) b.bootstrapDnsHosts(ips);
        return b.build();
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        if (isIpLiteral(hostname)) {
            // Nothing to resolve; getByName parses a literal without a query.
            return Collections.singletonList(InetAddress.getByName(hostname));
        }
        UnknownHostException last = null;
        for (Dns provider : providers) {
            try {
                List<InetAddress> found = provider.lookup(hostname);
                if (found != null && !found.isEmpty()) return found;
            } catch (UnknownHostException e) {
                last = e;
            } catch (Exception e) {
                // An HTTP error, a timeout or a malformed answer is that
                // provider's failure, not the whole lookup's. (OkHttp's
                // DnsOverHttps throws a plain IOException for an HTTP 5xx,
                // which the Dns signature does not declare.)
                UnknownHostException wrapped = new UnknownHostException(hostname + ": " + e.getMessage());
                wrapped.initCause(e);
                last = wrapped;
            }
        }
        UnknownHostException out = new UnknownHostException(
            hostname + " could not be resolved over HTTPS by any provider");
        if (last != null) out.initCause(last);
        throw out;
    }

    static boolean isIpLiteral(String host) {
        return host.indexOf(':') >= 0 || IPV4.matcher(host).matches();
    }
}
