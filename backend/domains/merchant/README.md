# domains/merchant/ — MERCHANT PLATFORM (BBEPS Phase 008)

The only authority for merchant lifecycle. Owns:

| Capability | Where |
|---|---|
| Merchant pay | Not here: team commission (Step 2e) is paid into the TEAM's pool by `database/repositories/teamCommission.js`, called from `domains/team/teamCommission.service.js`. A merchant holds no tokens (2c). |
| Merchant Analytics / Leaderboards / Performance History / Funding Statistics | `merchantAnalytics.service.js` + `merchantPlatform.admin.routes.js` (all derived, read-only) |
| Which member serves an order | Not here: team routing, `database/repositories/teamRouting.js` (Step 2c) |
| Lifecycle / profile / approval | `database/repositories/merchants.js`, `merchant.routes.js`, `merchant.admin.routes.js`, `merchant.assignment.routes.js` |
| Settlement rail | `merchantCurrency.js` — rail vocabulary over `Merchant.acceptedCurrencies`; only INR can be set (USDT buys are paid to the platform, CLAUDE.md §25) |

Hard rules (2026-07-08/09 decisions):
- Team commission is platform-funded: MERCHANT_BONUS_POOL (the team commission
  pool) → MERCHANT_FUNDS only; the pool is fundable only from distributable
  platform revenue (R&S). Never deduct users; never a spread.

Settlement rail (2026-07-27, revised 2026-10-18):
- A merchant settles on **exactly one** rail. Only INR can be set
  (`SETTABLE_MERCHANT_CURRENCIES`); USDT is a row from before USDT buys went to
  the platform (CLAUDE.md §25), holds no address and is routed nothing.
- Import the rail names and `USDT_CHAINS` from `merchantCurrency.js`. Do not
  re-declare 'INR'/'USDT' string literals (§4).
- `order_states.currency` is the order-side counterpart.
