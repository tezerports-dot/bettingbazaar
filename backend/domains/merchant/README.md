# domains/merchant/ — MERCHANT PLATFORM (BBEPS Phase 008)

The only authority for merchant lifecycle. Owns:

| Capability | Where |
|---|---|
| Merchant Performance Bonus Engine | `merchantBonus.service.js` (Cycle Tracker → Bonus Calculator → issuance; 10-min cron + on-demand admin trigger) |
| Merchant Bonus Settlement | issuance via `revenueSettlement.issueMerchantBonus()` (accounting) + `merchantWallet.creditMerchantBonus()` (wallet), one shared idempotency key |
| Merchant Wallet | `merchantWallet.service.js` — SOLE writer of `Merchant.tokenBalance` (§1); `merchantWallet.model.js` ledger |
| Merchant Analytics / Leaderboards / Performance History / Funding Statistics | `merchantAnalytics.service.js` + `merchantPlatform.admin.routes.js` (all derived, read-only) |
| Merchant Queue Integration | `merchantScoring.service.js` (scoring inputs for assignment) — the queue/assignment PROCESS itself is Funding Platform-owned (Phase 009) |
| Lifecycle / profile / approval | `merchant.model.js`, `merchant.routes.js`, `merchant.admin.routes.js`, `merchant.assignment.routes.js` |
| Settlement rail (INR-only vs USDT-only) | `merchantCurrency.js` — rail vocabulary + TRC-20 address validation over `Merchant.acceptedCurrencies` (§1) |

Hard rules (2026-07-08/09 decisions):
- Bonuses are platform-funded: MERCHANT_BONUS_POOL → MERCHANT_FUNDS only;
  the pool is fundable only from distributable platform revenue (R&S).
- Never calculated from buyRate/sellRate (retired). Never deduct users.
- Percentages/thresholds live ONLY in `MerchantBonusPolicy`
  (Business Policy Platform, domains/configuration).

Settlement rail (2026-07-27 decision):
- A merchant settles on **exactly one** rail — INR (UPI + bank) or USDT (TRC-20),
  never both. `Merchant.acceptedCurrencies` holds exactly one entry (schema
  validator); `merchantType` is a derived read-only virtual, never a second store.
- Import the rail names and `isTrc20Address` from `merchantCurrency.js`. Do not
  re-declare 'INR'/'USDT' string literals or a second address regex (§4).
- Enforced in `merchantScoring.selectBestMerchant` (assignment), the accept guard
  and open-pool filter in `merchant.routes.js`, and the rail-exclusive
  `PUT /profile`. `PaymentOrder.currency` is the order-side counterpart.
