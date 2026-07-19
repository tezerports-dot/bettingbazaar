# backend/domains/ — Enterprise Domain Map

Target architecture per BBEPS Phases 003–004, adapted to fit inside the existing
single-Express-app `backend/` (no monorepo split — see audit/PHASE0_BASELINE_AND_FINDINGS.md
§3 "middle road" and the 2026-07-01 approval). Each domain owns its models, services,
and routes. Cross-domain access goes through a domain's exported service functions,
never through another domain's internal state.

## Status legend
- **MIGRATED** — fully relocated here, legacy location deleted, imports updated, verified.
- **PLACEHOLDER** — folder + README only. Legacy code has NOT moved yet. Do not import
  from these folders; nothing lives here except this file.

## Domain map

| Domain | Status | Legacy location (still current source of truth until migrated) |
|---|---|---|
| `merchant/` | **MIGRATED** | was `models/merchant.model.js`, `services/merchantScoring.service.js`, `routes/merchant.routes.js`, `routes/admin/merchants.admin.routes.js`, part of `routes/admin/queue.admin.routes.js` |
| `payment/` | **MIGRATED** | was `models/paymentOrder.model.js`, `services/paymentProcessing.service.js`, `routes/payment.routes.js`, part of `routes/admin/queue.admin.routes.js` |
| `wallet/` | PLACEHOLDER | `services/walletAuthority.service.js` (sole wallet-mutation authority, GOVERNANCE §7), `models/wallet.model.js` |
| `game/` | PLACEHOLDER | `gameEngine.js`, `services/cycleGenerator.service.js`, `models/cycle.model.js` — this is the actual core product (proprietary cycle/crash engine). Not part of original BBEPS's generic domain list; added per Phase 0 evidence. |
| `betting/` | PLACEHOLDER | `models/bet.model.js`, `routes/bet.routes.js` |
| `sportsbook/` | PLACEHOLDER | No dedicated backend exists today — confirmed via repo search, only `models/gameProvider.model.js` / `routes/game-providers.routes.js`, which are third-party casino/game-provider integrations, not sports fixtures/odds. Frontend `SportsPage.tsx` is presentational only. This domain is effectively unbuilt. |
| `user/` | PLACEHOLDER | `models/user.model.js`, `routes/user.routes.js` |
| `identity/` | PLACEHOLDER | `middleware/auth.middleware.js`, `models/auth.model.js` |
| `support/` | PLACEHOLDER | Minimal/TBD — no dedicated ticketing backend found in Phase 0 audit |
| `disputes/` | PLACEHOLDER | `routes/admin/disputeResolution.admin.routes.js` (261 lines, real functionality) |
| `settlement/` | PLACEHOLDER | Currently embedded inside `gameEngine.js` cycle resolution + `walletAuthority.service.js`. Not yet isolated — a real BBEPS Phase 0 "Risk D domain leakage" candidate for a future migration. |
| `telegram/` | PLACEHOLDER | Not built. Only a support link field exists (`systemConfig.model.js` → `supportLinks.telegram`). |
| `analytics/` | PLACEHOLDER | `routes/admin/analytics.admin.routes.js` |
| `notification/` | PLACEHOLDER | `services/realtimeEmitters.js`, `services/sseManager.service.js`, `models/notification.model.js` |
| `cms/` | PLACEHOLDER | `services/content.service.js`, `models/content.model.js` |
| `configuration/` | PLACEHOLDER | `models/systemConfig.model.js` / `domains/configuration/systemConfig.model.js`; `TokenRates` was removed 2026-07-08 and token conversion is fixed 1:1. |
| `risk/` | PLACEHOLDER | `models/utrRegistry.model.js` — currently only a duplicate-UTR check, not real fraud/risk scoring. Mostly unbuilt per BBEPS's own "NEW domain" classification. |
| `responsible-gaming/` | PLACEHOLDER | Not built. Forward-looking domain (self-exclusion, limits — BBEPS Phase 006 §6.5 Category D). |

## Why `admin/` is NOT a domain folder

BBEPS Phase 003 §3.3 is explicit: *"Administration Domain... is not a business domain.
It is an orchestration layer. It does not own data."* Every domain rule in BBEPS
requires a domain to own its own data — admin functionality structurally can't, by
BBEPS's own definition, since everything it touches belongs to some other domain.

The existing `routes/admin/*.js` files stay where they are as the orchestration/API
layer. They call into domain services (e.g., the new `domains/merchant/` functions)
rather than owning any state themselves. This matches BBEPS §4.5: *"Admin Application...
orchestrates domains but owns no business state."*

## Known pre-existing dead scaffolding (not part of this migration, flagging for visibility)

`services/eventBus.service.js` and `services/featureFlags.service.js` exist in the
current repo but have zero importers anywhere — confirmed via repo-wide grep. They
appear to be unused scaffolding from an earlier migration phase. They are future
candidates for `shared/events/` and a feature-flag system respectively, once actually
wired up. Left in place and untouched for now — deleting or relocating unused-but-not-
yet-integrated code is a separate decision from this migration's scope (Merchant +
Payment only).
