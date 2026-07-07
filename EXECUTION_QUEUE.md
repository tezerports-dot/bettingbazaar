# Execution Queue — Phase 006 (Business Policy Platform)

**Purpose:** the ordered/optional-ordered list of concrete next tasks, so a
session can pick up work without re-deriving "what's next" from scratch. This
file didn't exist before 2026-07-07; created as part of the DepositPolicy
migration.

Completed items are kept (struck through in spirit, marked DONE) rather than
deleted, so this file also works as a short-form recent-history log.

---

## DONE — 2026-07-07

- [x] `DepositPolicy` model, service, admin routes (full versioning lifecycle:
      immediate/scheduled/approval-gated create, approve/reject, rollback,
      scheduled-apply, audit history).
- [x] Wired into real runtime consumption: `paymentOrder.model.js` pre-save
      hook (order creation) and `merchant.routes.js` POST `/orders/:id/approve`
      (the live approval path — fixed its independent hardcoded 90/10 too).
- [x] 04-GOVERNANCE.md updated: new §1 authority, §11 real-time event
      (`deposit_policy_updated`), and an explicit note on how this relates to
      the earlier "commissionRate retired" decision.
- [x] 11-assertion control-flow test against the real service code (version
      numbering, supersession, approval workflow, scheduled-apply, rollback
      semantics) + split-arithmetic conservation check.

---

## NOT STARTED — pick one next (see PHASE_STATUS.md "Next concrete step" for
## the reasoning behind leaving this an open choice rather than a fixed order)

- [ ] **Admin UI for DepositPolicy.** Small, contained. Same shape as the
      existing `/token-rates` admin page. Makes the backend built above
      actually usable without `curl`/Postman.
- [ ] **Merchant commission payout engine.** Bigger, separate design
      decision: how/when a merchant actually gets paid
      `merchantCommissionPercent` from platform funds — new `Transaction`
      type(s), ledger entries via `walletAuthority.service.js`, timing
      (per-order vs. batched settlement).
- [ ] **buyRate/sellRate → 1:1 flattening.** Independent of DepositPolicy.
      ~19 files reference `buyRate`/`sellRate` across models, routes,
      services, and both frontends (user-panel, admin-panel). Was the
      original next-task candidate before scope moved to DepositPolicy;
      still pending.

---

## KNOWN OPEN ITEMS (not urgent, not forgotten — see PHASE_STATUS.md for full detail)

- [ ] Reroute `merchant.routes.js` wallet-balance writes through
      `walletAuthority.service.js` (currently raw `$inc` — pre-existing
      §7 violation, not introduced by or fixed in this migration).
- [ ] Remove or repurpose `paymentProcessing.service.js`'s orphaned
      `approveDeposit()` (dead code, never called).
- [ ] Wire `applyScheduledPolicyChanges()` (and the older
      `applyScheduledConfigChanges()`) into `cronJobs.js`.
- [ ] Merchant `maxConcurrentOrders` production backfill confirmation.
- [ ] `PaymentGatewayConfig` — confirmed intentional future scaffolding, not
      yet wired in.
- [ ] `backend/debug-merchant-query.mjs` / `check-merchants.mjs` — stray,
      unimported debug scripts, safe to delete.
