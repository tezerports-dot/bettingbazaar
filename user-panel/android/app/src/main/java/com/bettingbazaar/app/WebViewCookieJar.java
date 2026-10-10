// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.webkit.CookieManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;

/**
 * The WebView's own cookie store, seen by SecureTransport.
 *
 * Before requests went native, the WebView kept the API's cookies itself
 * (Capacitor accepts third-party cookies for the bundle's https://localhost
 * page). Reading and writing the same android.webkit.CookieManager keeps that
 * one store: a cookie set on a native response is there for an <img> the
 * WebView loads, and the reverse. SecureTransport asks it only for a request
 * the page sent with `credentials: 'include'`.
 */
final class WebViewCookieJar implements CookieJar {

    @Override
    public void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
        if (cookies.isEmpty()) return;
        CookieManager cm = CookieManager.getInstance();
        String at = url.toString();
        for (Cookie c : cookies) cm.setCookie(at, c.toString());
        cm.flush();
    }

    @Override
    public List<Cookie> loadForRequest(HttpUrl url) {
        String header = CookieManager.getInstance().getCookie(url.toString());
        if (header == null || header.isEmpty()) return Collections.emptyList();
        List<Cookie> out = new ArrayList<>();
        for (String pair : header.split(";")) {
            Cookie c = Cookie.parse(url, pair.trim());
            if (c != null) out.add(c);
        }
        return out;
    }
}
