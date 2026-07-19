# Native app and desktop distribution policy

Betting Bazaar targets three first-party clients: the responsive desktop web site,
an Android app, and an iOS app. All clients must load the same licensed,
jurisdiction-aware HTTPS origin and must not disguise traffic through a
"harmless" proxy domain, hidden VPN, Shadowsocks bridge, or similar bypass layer.

## Approved architecture

```text
Desktop browser / Android WebView / iOS WebView
        │
        ▼
Official HTTPS origin (PUBLIC_APP_ORIGIN)
        │
        ▼
Caddy edge controls, WAF/header normalization, auth, KYC, geofence checks
        │
        ▼
Backend APIs and financial ledger
```

Native shells should call `GET /api/app/bootstrap` during startup and verify that
`officialOrigin` is in `allowedOrigins` before opening the WebView. The bootstrap
response also exposes package/bundle IDs and compliance booleans for clients to
fail closed if an app build was configured to use an unapproved origin.

## Explicitly disallowed

- Web-based proxy bridges that fetch and rewrite a blocked betting site through a
  generic or benign-looking landing domain.
- Hidden VPN, WireGuard, Shadowsocks, SOCKS, or tunnel clients whose purpose is
  to bypass local network or regulatory blocks.
- Domain rotation, geographic header stripping, or link rewriting designed to
  conceal the betting origin.

## Client requirements

- Use the official origin configured by `PUBLIC_APP_ORIGIN`.
- Keep KYC, geofencing, responsible gambling, and age-gating controls enabled in
  both native and browser clients.
- For Android, prefer a Play-distributed native shell or Trusted Web Activity
  only where betting distribution is permitted.
- For iOS, use an App Store-compliant native shell only in permitted regions; do
  not use private APIs or network extension entitlements for bypass behavior.
- For desktop, package a WebView shell only for permitted jurisdictions and keep
  updates tied to the same backend force-update controls used by the web app.
