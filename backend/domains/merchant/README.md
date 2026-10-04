# domains/merchant/ — MERCHANT PLATFORM (BBEPS Phase 008)

The only authority for merchant lifecycle. Owns:

| Capability | Where |
|---|---|
| Merchant pay | Not here: team commission (Step 2e) is paid into the TEAM's pool by `database/repositories/teamCommission.js`, called from `domains/team/teamCommission.service.js`. A merchant holds no tokens (2c). |
| Merchant Analytics / Leaderboards / Performance History / Funding Statistics | `merchantAnalytics.service.js` + `merchantPlatform.admin.routes.js` (all derived, read-only) |
| Which member serves an order | Not here: team routing, `database/repositories/teamRouting.js` (Step 2c) |
| Lifecycle / profile / approval | `database/repositories/merchants.js`, `merchant.routes.js`, `merchant.admin.routes.js`, `merchant.assignment.routes.js` |
| Settlement rail (INR-only vs USDT-only) | `merchantCurrency.js` — rail vocabulary + TRC-20 address validation over `Merchant.acceptedCurrencies` (§1) |

Hard rules (2026-07-08/09 decisions):
- Team commission is platform-funded: MERCHANT_BONUS_POOL (the team commission
  pool) → MERCHANT_FUNDS only; the pool is fundable only from distributable
  platform revenue (R&S). Never deduct users; never a spread.

Settlement rail (2026-07-27 decision):
- A merchant settles on **exactly one** rail — INR (UPI + bank) or USDT (TRC-20),
  never both. `Merchant.acceptedCurrencies` holds exactly one entry (schema
  validator); `merchantType` is a derived read-only virtual, never a second store.
- Import the rail names, the chain table and `isUsdtAddress` from
  `merchantCurrency.js`. Do not
  re-declare 'INR'/'USDT' string literals or a second address regex (§4).
- Enforced in team routing (`database/repositories/teamRouting.js`), the accept
  guard in `merchant.routes.js`, and the rail-exclusive `PUT /profile`.
  `order_states.currency` is the order-side counterpart.
