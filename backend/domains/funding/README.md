# domains/funding/ — FUNDING PLATFORM (BBEPS Phase 009)

The only authority for money entering and leaving the ecosystem.

| Capability | Where |
|---|---|
| INR deposits / withdrawals (intent-based, merchant-fulfilled P2P) | `fundingAuthority.service.js` → `MANUAL_P2P_INR` adapter → `domains/payment/paymentProcessing.service.js` (implementation detail of this platform) |
| USDT deposits / USDT treasury | `USDT_TRC20` adapter — declared, inactive until the treasury build (docs/governance/CAPABILITY_MATRIX_2026.md) |
| Future payment/crypto providers, gateway adapters | `providerRegistry.js` — one adapter interface; adding a rail touches no routes |
| Deposit verification / withdrawal processing | UTR validation, merchant confirm/approve flows (`domains/payment/`, `domains/merchant/merchant.routes.js`) — Funding-owned processes |
| Merchant assignment / queue | assignment + scoring machinery (`domains/merchant/merchant.assignment.routes.js`, `merchantScoring.service.js`) — the PROCESS is Funding-owned; scoring inputs are Merchant Platform-owned |
| Funding events | `fundingEvents.js` — first real eventBus wiring: PAYMENT_ORDER_CREATED published by the facade, PAYMENT_ORDER_COMPLETED published at the live completion points and consumed to nudge the R&S ledger reconciler within seconds |

Boundaries:
- **Never owns accounting logic** — the Revenue & Settlement Platform derives
  all ledger entries from completed orders.
- Never mutates balances — walletAuthority / merchantWallet only.
- Configurable rules — Business Policy Platform only.
- Existing implementation files stay in `domains/payment/` per the
  opportunistic-move rule (docs/governance/ENTERPRISE_DECISIONS.md 2026-07-07); this module
  is the authority boundary, not a file reshuffle.
