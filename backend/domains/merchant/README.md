# domains/merchant/ — MERCHANT PLATFORM (BBEPS Phase 008)

The only authority for merchant lifecycle. Owns:

| Capability | Where |
|---|---|
| Merchant pay | Not here: team commission (Step 2e) is paid into the TEAM's pool by `database/repositories/teamCommission.js`, called from `domains/team/teamCommission.service.js`. A merchant holds no tokens (2c). |
| Merchant Analytics / Leaderboards / Performance History / Funding Statistics | `merchantAnalytics.service.js` + `merchantPlatform.admin.routes.js` (all derived, read-only) |
| Which member serves an order | Not here: team routing, `database/repositories/teamRouting.js` (Step 2c) |
| Lifecycle / profile / approval | `database/repositories/merchants.js`, `merchant.routes.js`, `merchant.admin.routes.js`, `merchant.assignment.routes.js` |
| Settlement rail | None: every merchant serves INR. An order's currency vocabulary is `../payment/orderCurrency.js` (USDT buys are paid to the platform, CLAUDE.md §25) |

Hard rules (2026-07-08/09 decisions):
- Team commission is platform-funded: MERCHANT_BONUS_POOL (the team commission
  pool) → MERCHANT_FUNDS only; the pool is fundable only from distributable
  platform revenue (R&S). Never deduct users; never a spread.

Settlement rail (2026-07-27, removed 2026-10-18):
- No merchant has a rail: every merchant serves INR. USDT buys are paid to the
  platform (CLAUDE.md §25). Import 'INR'/'USDT' and `USDT_CHAINS` from
  `../payment/orderCurrency.js`; do not re-declare the strings (§4).
- `order_states.currency` is what an order is paid in.
