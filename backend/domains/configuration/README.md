# domains/configuration/ — MIGRATED

Owns `SystemConfig` (business policy values: bet limits, deposit/withdrawal limits,
feature flags, queue manager merchant pool). `TokenRates` was removed on 2026-07-08;
token conversion is fixed 1:1 and public rate endpoints return constants for compatibility.
Moved from `backend/models/systemConfig.model.js` on 2026-07-02.

**Known related item, not yet resolved:** `backend/routes/payment-config.routes.js`
reads a model called `PaymentGatewayConfig`, which is NOT exported from this file or
`models/index.js` — its definition wasn't located in this pass. Possible second,
separate configuration surface. Flagged for the next Configuration-domain pass.

Full domain map: see ../README.md.
