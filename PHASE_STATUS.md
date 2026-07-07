# Phase Status — Canonical Project State

**This file, not conversation history, is the source of truth for project state.**
Update it after every significant change. If this file and a chat summary disagree,
this file wins — that's the point of it existing.

Last updated: 2026-07-07

---

## BBEPS Phase Status

| Phase | Status | Evidence |
|---|---|---|
| 0 — Repository Baseline Assessment | Locked | audit/PHASE0_BASELINE_AND_FINDINGS.md |
| 002 — Capability Inventory | Locked (one open caveat) | Capability table in Phase 0 doc; "no orphaned functionality" being closed incrementally as each domain migration traces its own files |
| 003 — Domain Discovery & Bounded Contexts | Substantively complete | 13 domains with real code have enforced bounded contexts |
| 004 — Target Enterprise Architecture | Decision locked, execution complete for existing code | backend/domains/ + backend/shared/ inside the existing app |
| 005 — Technology Strategy | Corrected 2026-07-03 | Originally under-scoped (language choice only). Now includes real research: Provider/Adapter pattern and Policy/Rules-Engine pattern both confirmed as standard, industry-proven fits for this platform. See FUTURE_CAPABILITIES.md architecture decision. |
| 006 — Configuration Engine / Business Policy Platform | First vertical slice shipped (2026-07-07) | `domains/configuration/depositPolicy.model.js` + `.service.js` + `.admin.routes.js` — whole-document versioned policy (deposit/reserve split, merchant commission %, funding source, reserve usage rules, per-currency). Wired into real runtime consumers: `paymentOrder.model.js` pre-save hook and `merchant.routes.js` POST /orders/:id/approve (previously two independently hardcoded 90/10s — both now read the same policy-derived stored fields). Renamed in direction (not yet fully in code) to Business Policy Platform per 2026-07-03 decision — same underlying phase, wider scope. THIS IS THE CURRENT ACTIVE PHASE. |
| 007 — Enterprise Control Center / Operations Platform | Not started | Confirmed as orchestration-only, does not own data (2026-07-03) |
| 008 — Financial Core (ledger-first) | Not started | Wallet has correct single-writer authority; not the same as ledger-event-sourcing |
| 009 — Workflow Engine | Not started | — |
| 010 — Event Architecture | Not started | eventBus.service.js exists, zero importers |
| 011 — Algorithm Registry | Not started | Merchant scoring has real docs post-bugfix; reinforced (not replaced) by the platform-architecture decision |
| 012 — Business Process Catalog | Not started | — |

---

## Domain Migration Status

**Migrated (13):** Merchant, Payment, Configuration, Wallet, Betting, Game, Identity,
User, Disputes, Analytics, Notification, CMS, Settlement (partial by design — see
domains/settlement/README.md)

**Not domains — recorded as Platform capabilities, not fake placeholders:**
Communication, Risk, Provider, Business Policy (expanded), Algorithm Registry,
Operations Platform, Agent/Reseller Hierarchy — see FUTURE_CAPABILITIES.md for the
full architecture decision and reasoning.

---

## Known Open Items

1. Merchant `maxConcurrentOrders` data backfill — code fix confirmed live;
   production backfill confirmation was never closed out.
2. `PaymentGatewayConfig` (backend/models/payment.model.js) — confirmed intentional
   future third-party gateway scaffolding, not a bug, not yet wired in.
3. No MongoDB transactions in the settlement flow — correctness relies on
   idempotency keys, not atomicity. Documented, not changed.
4. `backend/debug-merchant-query.mjs` and `check-merchants.mjs` — stray debug
   scripts, not imported anywhere, safe to delete, not yet removed.
5. Phase 002 "no orphaned functionality" — verified at capability level only.
6. **Discovered 2026-07-07, not fixed (separate task):** `merchant.routes.js`
   POST `/orders/:id/approve` writes `User.depositBalance`/`reserveBalance` via
   raw `$inc` — a pre-existing 04-GOVERNANCE.md §7 violation ("all wallet
   balance reads/writes go through `walletAuthority.service.js`"). Not touched
   by the DepositPolicy migration (only the hardcoded ratio inside that same
   route was fixed) — rerouting these writes through `walletAuthority.service.js`
   is a bigger, separate change and deserves its own review.
7. **Discovered 2026-07-07, not fixed (dead code):** `paymentProcessing.service.js`
   exports `approveDeposit()`, which duplicates the logic in
   `merchant.routes.js`'s live `/orders/:id/approve` route but is never
   imported or called anywhere. Left as-is (out of scope for this migration);
   candidate for BBEPS §13 Dead Artifact cleanup.
8. **New with this migration:** `DepositPolicy.merchantCommissionPercent` and
   `commissionFundingSource` are fully modeled, validated, versioned, and
   admin-editable, but no code anywhere reads them to actually pay a merchant
   a platform-funded commission. That payout engine does not exist yet — see
   "Next concrete step" below.

---

## Current Active Phase

**Business Policy Platform** (BBEPS Phase 006, renamed/widened per 2026-07-03
decision). Goal: no business constant remains hardcoded in a service when
configuration is appropriate — merchant commission, reserve ratio, deposit split,
withdrawal rules, USDT rate, algorithm parameters, betting limits, KYC policy, risk
thresholds, feature toggles, notification templates, and more, admin-editable with
validation, defaults, examples, and audit history.

**Foundation built (2026-07-03):** `domains/configuration/configVersion.model.js`
and `configVersioning.service.js` — per-FIELD versioning on flat `key:'main'`
documents (SystemConfig, TokenRates). Correct for independent values (bet limits,
maintenance mode); still not retrofitted onto any existing config writes (deliberate,
separate decision — see Known Open Items).

**First policy vertical slice shipped (2026-07-07): `DepositPolicy`.**
Mid-session, the plan changed from "add one `reserveRatio` field to `SystemConfig`"
to "build the reusable whole-policy pattern," specifically because deposit%/
reserve%/commission%/funding-source/reserve-usage-rules are one coherent business
decision, not independent fields — versioning them separately (the
`configVersioning.service.js` field-level approach) would let them drift out of
sync mid-change. New files, all in `domains/configuration/`:
  - `depositPolicy.model.js` — each document IS a version (whole-policy, not
    per-field); exactly one ACTIVE document per currency; fields: `currency`
    (extensible list, `SUPPORTED_CURRENCIES`), `depositAllocationPercent` +
    `reserveAllocationPercent` (validated to sum to 100), `merchantCommissionPercent`,
    `commissionFundingSource` (locked to `'PLATFORM'` — hard business rule, not a
    default), `reserveUsageRules` (typed, not Mixed), plus the same
    approval/scheduling/rollback lifecycle fields as `ConfigVersion`.
  - `depositPolicy.service.js` — sole writer. `createPolicyVersion` (immediate /
    scheduled / approval-gated, mirrors `setConfigField`'s status logic but also
    supersedes the prior ACTIVE version for that currency), `approvePolicyVersion`,
    `rollbackToPolicyVersion` (creates a new version copying old field values
    forward — never mutates or resurrects history), `applyScheduledPolicyChanges`
    (not yet wired into `cronJobs.js` — same status as `applyScheduledConfigChanges`),
    `getActivePolicy` (the runtime read path), `getPolicyHistory` (audit trail).
  - `depositPolicy.admin.routes.js` — `GET /api/admin/deposit-policy/:currency`,
    `GET .../:currency/history`, `PUT .../:currency` (create version — requires
    `businessJustification`), `POST .../version/:id/approve`,
    `POST .../version/:id/rollback`. Mounted via `routes/admin/index.js`
    (zero changes needed in `server.js`). Emits `deposit_policy_updated`
    (registered in 04-GOVERNANCE.md §11) and writes `EnhancedAuditLog` entries
    (category `FINANCIAL`) on every write.
  - Verified with an 11-assertion control-flow mock test against the real
    service code (same documented constraint as `configVersioning.service.js`:
    `mongodb-memory-server`'s binary download is blocked by this sandbox's
    network allowlist) — version numbering, immediate/scheduled/pending-approval
    branching, supersession (exactly one ACTIVE per currency, always), approval
    workflow, scheduled-apply, and rollback-never-mutates-history all passed.
    Split arithmetic (`Math.floor` + remainder-to-deposit, BBEPS Spec 4.4)
    separately verified to conserve the full token amount across edge cases
    including small amounts and non-round percentages.

**Runtime consumption — real, not just plumbing:**
  - `paymentOrder.model.js` pre-save hook now reads the active `DepositPolicy`
    for `'INR'` (statically imported, no dynamic `import()`) at order-creation
    time only, computes `depositAllocation`/`reserveAllocation` from it, and
    snapshots the policy version + terms onto the order
    (`depositPolicySnapshot`) for audit/reconciliation. Falls back to a logged
    90/10 only if no policy has ever been configured (fresh-install bootstrap
    state).
  - `merchant.routes.js` POST `/orders/:id/approve` — **this is the route that
    actually runs in production** (the alternate `approveDeposit()` in
    `paymentProcessing.service.js` is dead code, never called — see Known Open
    Items). It previously had its OWN independent hardcoded 90/10, silently
    ignoring the model's computed fields — a real 04-GOVERNANCE.md §2 violation
    ("no second write path to a value with a designated single-writer
    service") that predates this migration. Fixed to consume
    `order.depositAllocation`/`order.reserveAllocation` instead of recomputing.
  - `04-GOVERNANCE.md` §1 updated: new `DepositPolicy` authority added,
    explicitly noted as superseding "Merchant earnings model: buy/sell spread
    only, commissionRate retired" for the platform-funded-commission case —
    not a silent contradiction of that earlier decision.

**Not yet done, explicitly out of scope for this piece:**
- No merchant-commission payout engine exists. `merchantCommissionPercent` /
  `commissionFundingSource` are captured, versioned, validated, and readable —
  no code executes an actual platform-funded payment to a merchant yet.
- `applyScheduledPolicyChanges()` not wired into `cronJobs.js`.
- The pre-existing `merchant.routes.js` raw-`$inc` wallet writes (§7 violation)
  were not rerouted through `walletAuthority.service.js` — only the ratio
  itself was fixed. See Known Open Items #6.
- `SUPPORTED_CURRENCIES` includes `'USDT'` but no USDT deposit flow exists yet
  to actually create an order with that currency — schema/service are ready,
  nothing calls them for USDT today.
- No admin-panel frontend UI for editing DepositPolicy yet (backend is fully
  wired: model, service, versioning, validation, admin API, audit, runtime
  consumption). Same shape as `/token-rates`'s existing admin page — would be
  a small, contained follow-on.

**Next concrete step (pick one):**
1. **Admin UI for DepositPolicy** — small, contained, makes the already-built
   backend actually usable by a human admin instead of only via `curl`/Postman.
2. **Merchant commission payout engine** — the bigger, separate piece flagged
   above: define how/when a merchant is actually paid `merchantCommissionPercent`
   from platform funds (new Transaction type, ledger entries via
   `walletAuthority.service.js`, and a decision on timing — per-order vs.
   batched settlement).
3. **buyRate/sellRate → 1:1 flattening** — the other major piece of the 2026-07
   business-model change, independent of DepositPolicy, ~19 files affected.

Not yet decided which — flagging as an open choice rather than picking one
unilaterally, since #2 in particular is a real financial-flow design decision,
not just an implementation detail.
