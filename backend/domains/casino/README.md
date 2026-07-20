# domains/casino/ — CASINO PLATFORM (BBEPS Phase 011)

Third-party casino/game-provider integration (Evolution, Pragmatic, Spribe,
Betby, ...). Moved 2026-07-09 from models/gameProvider.model.js +
routes/game-providers.routes.js (git mv) — Product Platforms tier.

| File | Role |
|---|---|
| `gameProvider.model.js` | Provider config + GameTransaction records |
| `gameProvider.routes.js` | Admin provider config, user launch sessions, provider wallet webhooks (bet/win/rollback) |

Core-platform consumption:
- **Wallet authority**: every provider bet/win/rollback debits/credits via
  `walletAuthority.service.js` (`debitForGameProviderBet` preserves the
  provider-txId idempotency contract).
- **Business Policy**: provider enablement/credentials are admin-configured
  documents, not hardcoded (`FLAGS.LIVE_CASINO` gates future expansion).
- **Revenue & Settlement**: casino GGR accounting integration is queued
  (docs/governance/CAPABILITY_MATRIX_2026.md) — GameTransaction records are the source records the
  R&S reconciler pattern will derive from, same as PaymentOrders/Cycles.
