# Native app and desktop distribution policy

Betting Bazaar targets three first-party clients: the responsive desktop web site,
an Android app, and an iOS app. 

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
`officialOrigin` is in `allowedOrigins` before opening the WebView. 
