// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;

/**
 * SecureHttp — the web bundle's network requests, made natively over
 * SecureTransport so that every hostname is resolved over DNS-over-HTTPS
 * (DohDns) and never by the phone's own resolver (owner, 2026-10-10).
 *
 * The WebView offers no way to change how IT looks hosts up, so the bundle does
 * not let it: user-panel/src/services/secureTransport.ts replaces fetch() and
 * EventSource inside the shell with calls to this plugin. Registered in
 * MainActivity.
 *
 *   request({ id, url, method, headers, body, redirect, credentials, timeoutMs })
 *       → { status, statusText, headers: [[name, value]…], body, url, redirected }
 *       bodies travel base64-encoded both ways (binary-safe)
 *   cancel({ id })                 aborts a request or a stream
 *   openStream({ id, url, headers, credentials })
 *       events on "stream": { id, type: 'open', status, headers… }
 *                           { id, type: 'data', text }
 *                           { id, type: 'end', error? }
 *
 * A refusal or network failure rejects with code NETWORK (or ABORTED when the
 * page cancelled it) — the bundle turns those into the TypeError / AbortError a
 * browser's fetch() would throw, so the callers' own handling is unchanged.
 */
@CapacitorPlugin(name = "SecureHttp")
public class SecureHttpPlugin extends Plugin {

    private SecureTransport transport() {
        return SecureNetwork.transport();
    }

    @PluginMethod
    public void request(PluginCall call) {
        final SecureTransport.Spec spec;
        try {
            spec = specFrom(call);
            String body = call.getString("body");
            if (body != null) spec.body = Base64.decode(body, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid request: " + e.getMessage(), "NETWORK");
            return;
        }
        spec.method = call.getString("method", "GET");
        spec.followRedirects = !"error".equals(call.getString("redirect", "follow"));
        // getInt, not getLong: a JSON number this small arrives as an Integer,
        // and PluginCall.getLong answers null for one.
        Integer timeout = call.getInt("timeoutMs");
        spec.timeoutMs = timeout == null || timeout < 0 ? 0 : timeout;

        transport().execute(call.getString("id"), spec, new SecureTransport.ResultCallback() {
            @Override public void onResult(SecureTransport.Result r) {
                JSObject ret = headOf(r);
                ret.put("body", Base64.encodeToString(r.body, Base64.NO_WRAP));
                call.resolve(ret);
            }

            @Override public void onFailure(IOException error, boolean cancelled) {
                call.reject(cancelled ? "The request was aborted." : String.valueOf(error.getMessage()),
                    cancelled ? "ABORTED" : "NETWORK");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) transport().cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void openStream(PluginCall call) {
        final String id = call.getString("id");
        if (id == null) { call.reject("A stream needs an id.", "NETWORK"); return; }
        final SecureTransport.Spec spec;
        try {
            spec = specFrom(call);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid request: " + e.getMessage(), "NETWORK");
            return;
        }
        call.resolve();
        transport().openStream(id, spec, new SecureTransport.StreamListener() {
            @Override public void onOpen(SecureTransport.Result head) {
                JSObject e = headOf(head);
                e.put("id", id);
                e.put("type", "open");
                notifyListeners("stream", e);
            }

            @Override public void onData(String text) {
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("type", "data");
                e.put("text", text);
                notifyListeners("stream", e);
            }

            @Override public void onEnd(IOException error) {
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("type", "end");
                if (error != null) e.put("error", String.valueOf(error.getMessage()));
                notifyListeners("stream", e);
            }
        });
    }

    private static SecureTransport.Spec specFrom(PluginCall call) {
        SecureTransport.Spec spec = new SecureTransport.Spec();
        spec.url = call.getString("url");
        if (spec.url == null) throw new IllegalArgumentException("no url");
        spec.sendCookies = "include".equals(call.getString("credentials", "same-origin"));
        JSObject headers = call.getObject("headers", new JSObject());
        if (headers != null) {
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                String value = headers.optString(name, null);
                if (value != null) spec.headers.add(new String[] { name, value });
            }
        }
        return spec;
    }

    private static JSObject headOf(SecureTransport.Result r) {
        JSObject ret = new JSObject();
        ret.put("status", r.status);
        ret.put("statusText", r.statusText == null ? "" : r.statusText);
        ret.put("url", r.url);
        ret.put("redirected", r.redirected);
        JSArray headers = new JSArray();
        for (String[] h : r.headers) {
            JSArray pair = new JSArray();
            pair.put(h[0]);
            pair.put(h[1]);
            headers.put(pair);
        }
        ret.put("headers", headers);
        return ret;
    }
}
