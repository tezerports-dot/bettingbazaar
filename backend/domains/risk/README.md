# domains/risk/ — RISK PLATFORM (BBEPS Phase 010)

The single authority for operational rules and transaction validation.

| Capability | Status | Where |
|---|---|---|
| Transaction validation (positive / numeric / whole) | LIVE | `riskValidation.service.js` — pure validators |
| Multiples of 10 (buy / sell / bet) | LIVE (config-gated, default ON per 2026-07-09 directive) | `assessFundingOrder` / `assessBet` reading `SystemConfig.riskRules.enforceMultiplesOf10` |
| Betting limits | LIVE | `assessBet` (numbers from `SystemConfig.betLimits`) |
| Velocity limits (funding orders/hour) | LIVE (default off = 0) | `assessFundingOrder` reading `riskRules.maxFundingOrdersPerHour` |
| Opposite-side betting restriction | LIVE (default off) | `assessBet` reading `riskRules.blockOppositeSideBetting` |
| Reserve-ratio rounding (Spec 4.4) | LIVE | `computeReserveSplit` — consumed by `paymentOrder.model.js` pre-save |
| Payout fee rule | LIVE (default 0%) | `computePayoutFeeMinor` — % owned by `SystemConfig.payoutFeePercent`; fee recorded in the PAYOUT_FEES ledger account by R&S |
| Reserve wallet usage rules | Owned by `DepositPolicy.reserveUsageRules` (Business Policy) — Risk enforces when a consumer flow exists | — |
| AML / fraud detection / device risk / behaviour analysis / responsible gaming | DECLARED, not implemented (no fake placeholders) | docs/governance/EXECUTION_QUEUE.md |

Boundaries: Business Policy Platform owns every configurable number/toggle
(`SystemConfig.riskRules`, `payoutFeePercent`, `betLimits`, policy docs);
this platform reads and enforces. It never mutates balances and never
writes financial records.

Wired consumers: `paymentProcessing.service.js` (deposit + withdrawal
creation, behind the Funding Platform facade), `bet.routes.js` (placement),
`paymentOrder.model.js` (reserve split).
