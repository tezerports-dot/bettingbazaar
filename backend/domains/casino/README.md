# domains/casino/ — CASINO PLATFORM (BBEPS Phase 011)

Third-party casino/game-provider integration (Evolution, Pragmatic, Spribe,
Betby, ...). Moved 2026-07-09 from models/gameProvider.model.js +
routes/game-providers.routes.js (git mv) — Product Platforms tier.

| File | Role |
|---|---|
| `gameProvider.routes.js` | Admin provider config, user launch sessions, provider wallet webhooks (bet/win/rollback) |

Core-platform consumption:
- **Wallet**: every provider bet/win/rollback moves money through
  `db.casino.applyProviderCallback`, which writes the balance movement and the
  provider-transaction record in ONE transaction, keyed on the provider's own
  transaction id for idempotency.
- **Business Policy**: provider enablement/credentials are admin-configured
  documents, not hardcoded (`FLAGS.LIVE_CASINO` gates future expansion).
- **Revenue & Settlement**: casino GGR accounting integration is queued
  (CLAUDE.md) — GameTransaction records are the source records the
  R&S reconciler pattern will derive from, same as PaymentOrders/Cycles.
