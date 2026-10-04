# domains/funding/ — FUNDING PLATFORM (BBEPS Phase 009)

The only authority for money entering and leaving the ecosystem.

| Capability | Where |
|---|---|
| INR deposits / withdrawals (intent-based, merchant-fulfilled P2P) | `fundingAuthority.service.js` → `MANUAL_P2P_INR` adapter → `domains/payment/paymentProcessing.service.js` (implementation detail of this platform) |
| USDT deposits / USDT treasury | `USDT_TRC20` adapter — declared, inactive until the treasury build (CLAUDE.md) |
| Future payment/crypto providers, gateway adapters | `providerRegistry.js` — one adapter interface; adding a rail touches no routes |
| Deposit verification / withdrawal processing | UTR validation, merchant confirm/approve flows (`domains/payment/`, `domains/merchant/merchant.routes.js`) — Funding-owned processes |
| Which member serves an order | team routing (`database/repositories/teamRouting.js`, called by `paymentProcessing.tryAssignMerchant`; admin moves in `domains/merchant/merchant.assignment.routes.js`) — no scoring, no open pool (Step 2c) |
| Funding events | `fundingEvents.js` — first real eventBus wiring: PAYMENT_ORDER_CREATED published by the facade, PAYMENT_ORDER_COMPLETED published at the live completion points and consumed to nudge the R&S ledger reconciler within seconds |

Boundaries:
- **Never owns accounting logic** — the Revenue & Settlement Platform derives
  all ledger entries from completed orders.
- Never mutates balances — walletAuthority (players) / teamPools (team tokens) only.
- Configurable rules — Business Policy Platform only.
- Existing implementation files stay in `domains/payment/` per the
  opportunistic-move rule (CLAUDE.md 2026-07-07); this module
  is the authority boundary, not a file reshuffle.
