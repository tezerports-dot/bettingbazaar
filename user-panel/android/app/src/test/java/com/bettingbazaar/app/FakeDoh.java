// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import mockwebserver3.Dispatcher;
import mockwebserver3.MockResponse;
import mockwebserver3.MockWebServer;
import mockwebserver3.RecordedRequest;
import okhttp3.Dns;
import okhttp3.OkHttpClient;
import okio.Buffer;

/**
 * A DNS-over-HTTPS server for tests: answers RFC 8484 queries (application/
 * dns-message) from a map of name → IPv4, NXDOMAIN for anything else, and
 * records every name it was asked. Plain HTTP on 127.0.0.1, so the test's DoH
 * client needs no lookup of its own.
 */
final class FakeDoh implements java.io.Closeable {

    final MockWebServer server = new MockWebServer();
    final Map<String, byte[]> answers = new ConcurrentHashMap<>();
    final List<String> asked = new CopyOnWriteArrayList<>();
    volatile int failWithStatus = 0;

    FakeDoh() throws Exception {
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) {
                if (failWithStatus != 0) return new MockResponse.Builder().code(failWithStatus).build();
                byte[] query;
                String q = request.getUrl().queryParameter("dns");
                if (q != null) query = Base64.getUrlDecoder().decode(q);
                else query = request.getBody() == null ? new byte[0] : request.getBody().toByteArray();
                return new MockResponse.Builder()
                    .setHeader("Content-Type", "application/dns-message")
                    .body(new Buffer().write(answer(query)))
                    .build();
            }
        });
        server.start(java.net.InetAddress.getByName("127.0.0.1"), 0);
    }

    FakeDoh map(String host, int a, int b, int c, int d) {
        answers.put(host.toLowerCase(), new byte[] { (byte) a, (byte) b, (byte) c, (byte) d });
        return this;
    }

    /** A DohDns provider pointed at this server. */
    Dns provider(OkHttpClient client) {
        return DohDns.provider(client, "http://127.0.0.1:" + server.getPort() + "/dns-query");
    }

    private byte[] answer(byte[] query) {
        // Question section: QNAME labels, then QTYPE and QCLASS.
        int p = 12;
        StringBuilder name = new StringBuilder();
        while (query[p] != 0) {
            int len = query[p] & 0xff;
            if (name.length() > 0) name.append('.');
            name.append(new String(query, p + 1, len, java.nio.charset.StandardCharsets.US_ASCII));
            p += len + 1;
        }
        p += 1;
        int qtype = ((query[p] & 0xff) << 8) | (query[p + 1] & 0xff);
        int questionEnd = p + 4;
        String host = name.toString().toLowerCase();
        asked.add(host);

        byte[] ip = answers.get(host);
        boolean known = ip != null;
        boolean answerA = known && qtype == 1;

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(query[0]);
        out.write(query[1]);                       // the query's id
        out.write(0x81);
        out.write(known ? 0x80 : 0x83);           // response, RD+RA; NXDOMAIN when unknown
        out.write(0); out.write(1);                // QDCOUNT
        out.write(0); out.write(answerA ? 1 : 0);  // ANCOUNT
        out.write(0); out.write(0);                // NSCOUNT
        out.write(0); out.write(0);                // ARCOUNT
        out.write(query, 12, questionEnd - 12);
        if (answerA) {
            out.write(0xc0); out.write(0x0c);      // name: pointer to the question
            out.write(0); out.write(1);            // A
            out.write(0); out.write(1);            // IN
            out.write(0); out.write(0); out.write(0); out.write(60); // TTL
            out.write(0); out.write(4);
            out.write(ip, 0, 4);
        }
        return out.toByteArray();
    }

    @Override public void close() {
        server.close();
    }
}
