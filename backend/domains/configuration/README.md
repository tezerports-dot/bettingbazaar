# domains/configuration/ — MIGRATED

Owns `SystemConfig` (business policy values: bet limits, deposit/withdrawal limits,
feature flags, queue manager merchant pool) and `TokenRates` (buy/sell rate).
Moved from `backend/models/systemConfig.model.js` on 2026-07-02.

The payment-gateway settings surface (`backend/routes/payment-config.routes.js`)
reads and writes through `db.paymentConfig.getGatewayConfig` /
`setGatewayConfig` — PostgreSQL, like everything else. `PaymentGatewayConfig`
survives only as an audit-log `targetType` label, not as a store.

Full domain map: see ../README.md.
