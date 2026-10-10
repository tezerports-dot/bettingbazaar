// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * The app's one network client (CLAUDE.md §2 "How the Android app reaches the
 * network"): OkHttp with every hostname resolved by DohDns and the WebView's
 * cookie store. SecureHttpPlugin (the web bundle's requests) and
 * ApkUpdaterPlugin (update downloads) both go through it, so nothing this app
 * fetches uses the phone's own resolver.
 *
 * Built once, lazily: one connection pool and one DoH client for the process.
 */
final class SecureNetwork {

    /** Per address tried, and per lookup, for one DoH provider. */
    private static final int DOH_CONNECT_SECONDS = 4;
    private static final int DOH_LOOKUP_SECONDS = 8;

    private static SecureTransport transport;

    private SecureNetwork() {}

    static synchronized SecureTransport transport() {
        if (transport == null) {
            // The DoH queries themselves: their own pool, reaching the
            // providers by fixed address (DohDns.standard's bootstrap list).
            //
            // Short deadlines: each provider has four fixed addresses, and on a
            // network that silently DROPS packets to them (rather than
            // refusing), OkHttp's default 10 s connect timeout per address
            // would hold one lookup for ~40 s before the second provider is
            // even asked.
            OkHttpClient shared = new OkHttpClient.Builder().build();
            OkHttpClient bootstrap = shared.newBuilder()
                .connectTimeout(DOH_CONNECT_SECONDS, TimeUnit.SECONDS)
                .callTimeout(DOH_LOOKUP_SECONDS, TimeUnit.SECONDS)
                .build();
            DohDns dns = DohDns.standard(bootstrap);
            OkHttpClient client = SecureTransport
                .clientBuilder(shared.newBuilder(), dns, new WebViewCookieJar())
                .build();
            transport = new SecureTransport(client);
        }
        return transport;
    }
}
