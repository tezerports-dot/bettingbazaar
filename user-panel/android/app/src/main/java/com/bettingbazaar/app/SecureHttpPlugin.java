// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.sse.EventSource;
import okhttp3.sse.EventSourceListener;
import okhttp3.sse.EventSources;

/**
 * SecureHttp — the web screens' requests, sent from the native side.
 *
 * The screens run in Android's WebView, and WebView resolves hostnames with
 * the phone's DNS and offers no way to change that. So the app's one transport
 * door (user-panel/src/services/secureTransport.ts) hands each request to this
 * plugin instead, which sends it with {@link SecureNetwork}'s client and its
 * encrypted resolver ({@link SecureDns}).
 *
 *   request()      one HTTP exchange; resolves with status, headers and body
 *   cancel()       aborts a request() by the id the page gave it
 *   openStream()   a live-updates (Server-Sent Events) connection; its events
 *                  arrive as "streamEvent" notifications tagged with the id
 *   closeStream()  closes one
 *   status()       which resolver answered last, for on-device checks
 *
 * Only https is accepted: the page decides WHICH host (originFailover.ts holds
 * that trust decision), this decides HOW it is reached. Cookies are neither
 * sent nor kept, the same as the WebView did for the API's cross-site cookies;
 * the app signs requests with its Authorization header.
 *
 * Registered in MainActivity.
 */
@CapacitorPlugin(name = "SecureHttp")
public class SecureHttpPlugin extends Plugin {

    /** A response larger than this is refused rather than copied across the bridge. */
    private static final long MAX_BODY_BYTES = 20L * 1024 * 1024;

    private final Map<String, Call> calls = new ConcurrentHashMap<>();
    private final Map<String, EventSource> streams = new ConcurrentHashMap<>();
    /** Streams the page has not closed. Marked before connecting, so an instant failure is still reported. */
    private final Set<String> live = ConcurrentHashMap.newKeySet();

    @PluginMethod
    public void request(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        final String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        final String redirect = call.getString("redirect", "follow");

        HttpUrl parsed = url == null ? null : HttpUrl.parse(url);
        if (id == null || parsed == null || !parsed.isHttps()) { call.reject("Only https requests are sent.", "INSECURE_URL"); return; }

        Headers headers = headersOf(call.getObject("headers"));
        RequestBody body;
        try {
            body = bodyOf(call, method, headers.get("Content-Type"));
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "BAD_REQUEST");
            return;
        }

        Request request;
        try {
            request = new Request.Builder().url(parsed).headers(headers).method(method, body).build();
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "BAD_REQUEST");
            return;
        }

        OkHttpClient client = SecureNetwork.get().client();
        if (!"follow".equals(redirect)) client = client.newBuilder().followRedirects(false).build();

        Call http = client.newCall(request);
        calls.put(id, http);
        http.enqueue(new Callback() {
            @Override
            public void onFailure(@NonNull Call c, @NonNull IOException e) {
                calls.remove(id);
                if (c.isCanceled()) call.reject("The request was cancelled.", "ABORTED");
                else call.reject("The request could not reach the server.", "NETWORK", e);
            }

            @Override
            public void onResponse(@NonNull Call c, @NonNull Response response) {
                calls.remove(id);
                try (Response r = response) {
                    // fetch(…, { redirect: 'error' }) rejects instead of following.
                    if ("error".equals(redirect) && r.isRedirect()) {
                        call.reject("The server answered with a redirect, which this request refuses.", "REDIRECT_REFUSED");
                        return;
                    }
                    ResponseBody rb = r.body();
                    long declared = rb.contentLength();
                    if (declared > MAX_BODY_BYTES) { call.reject("The response is too large.", "TOO_LARGE"); return; }
                    byte[] bytes = rb.bytes();
                    if (bytes.length > MAX_BODY_BYTES) { call.reject("The response is too large.", "TOO_LARGE"); return; }

                    JSObject ret = new JSObject();
                    ret.put("status", r.code());
                    ret.put("statusText", r.message());
                    ret.put("url", r.request().url().toString());
                    JSObject h = new JSObject();
                    for (String name : r.headers().names()) {
                        h.put(name, String.join(", ", r.headers(name)));
                    }
                    ret.put("headers", h);
                    MediaType type = rb.contentType();
                    if (isText(type)) ret.put("bodyText", new String(bytes, StandardCharsets.UTF_8));
                    else ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    call.resolve(ret);
                } catch (IOException e) {
                    if (c.isCanceled()) call.reject("The request was cancelled.", "ABORTED");
                    else call.reject("The response could not be read.", "NETWORK", e);
                }
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        Call http = id == null ? null : calls.remove(id);
        if (http != null) http.cancel();
        call.resolve();
    }

    @PluginMethod
    public void openStream(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        HttpUrl parsed = url == null ? null : HttpUrl.parse(url);
        if (id == null || parsed == null || !parsed.isHttps()) { call.reject("Only https streams are opened.", "INSECURE_URL"); return; }

        Request request = new Request.Builder().url(parsed).headers(headersOf(call.getObject("headers"))).build();
        // A live stream is quiet between events: no read timeout. A dead socket
        // is found by the page reopening the stream on every foreground
        // (nativeLifecycle.ts) and by the server's own heartbeat.
        OkHttpClient streaming = SecureNetwork.get().client().newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build();
        live.add(id);
        EventSource source = EventSources.createFactory(streaming).newEventSource(request, new EventSourceListener() {
            @Override
            public void onOpen(@NonNull EventSource es, @NonNull Response response) {
                JSObject m = message(id, "open");
                m.put("status", response.code());
                notifyListeners("streamEvent", m);
            }

            @Override
            public void onEvent(@NonNull EventSource es, @Nullable String eventId, @Nullable String type, @NonNull String data) {
                JSObject m = message(id, "message");
                m.put("type", type == null ? "message" : type);
                m.put("data", data);
                if (eventId != null) m.put("lastEventId", eventId);
                notifyListeners("streamEvent", m);
            }

            @Override
            public void onClosed(@NonNull EventSource es) {
                // The server ended the stream: a browser reconnects, and so does the page.
                if (!ended(id)) return;
                JSObject m = message(id, "error");
                m.put("fatal", false);
                notifyListeners("streamEvent", m);
            }

            @Override
            public void onFailure(@NonNull EventSource es, @Nullable Throwable t, @Nullable Response response) {
                if (!ended(id)) return;   // closed by the page
                JSObject m = message(id, "error");
                // EventSource semantics: a refusal (not 200, or not an event
                // stream) is final; a dropped connection is retried.
                boolean refused = response != null;
                m.put("fatal", refused);
                if (response != null) m.put("status", response.code());
                notifyListeners("streamEvent", m);
            }
        });
        streams.put(id, source);
        // Closed, or already failed, before it was stored: nothing will cancel it later.
        if (!live.contains(id) && streams.remove(id) != null) source.cancel();
        call.resolve();
    }

    /** True the first time a stream ends; false once the page closed it or it already ended. */
    private boolean ended(String id) {
        streams.remove(id);
        return live.remove(id);
    }

    @PluginMethod
    public void closeStream(PluginCall call) {
        String id = call.getString("id");
        if (id != null) live.remove(id);
        EventSource source = id == null ? null : streams.remove(id);
        if (source != null) source.cancel();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SecureDns dns = SecureNetwork.get().dns();
        JSObject ret = new JSObject();
        ret.put("lastSource", dns.lastSource().name().toLowerCase(Locale.ROOT));
        ret.put("encryptedAnswers", dns.encryptedAnswers());
        ret.put("systemAnswers", dns.systemAnswers());
        ret.put("encryptedPaused", dns.encryptedPaused());
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        for (Call c : calls.values()) c.cancel();
        calls.clear();
        live.clear();
        for (EventSource s : streams.values()) s.cancel();
        streams.clear();
    }

    private static JSObject message(String id, String kind) {
        JSObject m = new JSObject();
        m.put("id", id);
        m.put("kind", kind);
        return m;
    }

    private static Headers headersOf(@Nullable JSObject obj) {
        Headers.Builder b = new Headers.Builder();
        if (obj == null) return b.build();
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            String value = obj.optString(name, null);
            // Cookies are not this transport's to send (see the class comment).
            if (value != null && !"cookie".equalsIgnoreCase(name)) b.add(name, value);
        }
        return b.build();
    }

    @Nullable
    private static RequestBody bodyOf(PluginCall call, String method, @Nullable String contentType) {
        MediaType type = contentType == null ? null : MediaType.parse(contentType);
        String text = call.getString("bodyText");
        String base64 = call.getString("bodyBase64");
        byte[] bytes = null;
        if (text != null) bytes = text.getBytes(StandardCharsets.UTF_8);
        else if (base64 != null) bytes = Base64.decode(base64, Base64.DEFAULT);

        boolean noBody = "GET".equals(method) || "HEAD".equals(method);
        if (noBody) {
            if (bytes != null) throw new IllegalArgumentException("A " + method + " request cannot have a body.");
            return null;
        }
        // OkHttp requires a body for POST, PUT and PATCH; fetch sends an empty one.
        return RequestBody.create(bytes == null ? new byte[0] : bytes, type);
    }

    private static boolean isText(@Nullable MediaType type) {
        if (type == null) return false;
        String t = type.type().toLowerCase(Locale.ROOT);
        String s = type.subtype().toLowerCase(Locale.ROOT);
        return "text".equals(t) || s.equals("json") || s.endsWith("+json") || s.equals("xml") || s.endsWith("+xml")
            || s.equals("javascript") || s.equals("x-www-form-urlencoded");
    }
}
