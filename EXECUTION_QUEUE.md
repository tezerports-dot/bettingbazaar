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
- [x] Found and fixed a third, previously-missed hardcoded 90/10 in
      `paymentProcessing.service.js`'s `createDepositOrder()` — the
      user-facing order confirmation message was built from stale local
      variables instead of the actual post-save, policy-derived values.
- [x] 04-GOVERNANCE.md updated: new §1 authority, §11 real-time event
      (`deposit_policy_updated`), and an explicit note on how this relates to
      the earlier "commissionRate retired" decision.
- [x] 11-assertion control-flow test against the real service code (version
      numbering, supersession, approval workflow, scheduled-apply, rollback
      semantics) + split-arithmetic conservation check.
- [x] Admin-panel UI: `Pages/BusinessPolicy/DepositPolicy.tsx` — currency
      tabs, active-policy view, empty-state "Configure Now", example
      calculator, version history with approve/reject/rollback, create-
      version form. New `'policy'` nav group. Verified with a real
      `tsc --noEmit` (zero new errors) and a real `vite build` (succeeds).
- [x] Formalized platform-oriented architecture direction (Business Policy,
      Operations, Revenue & Settlement, Merchant, Funding, Risk, Sportsbook,
      Casino, Communication) — see ENTERPRISE_DECISIONS.md.

---

## NEXT — per established dependency order (not an open choice)

- [ ] **buyRate/sellRate → 1:1 flattening.** Explicitly deferred until the
      Business Policy foundation was complete (2026-07-07 decision); that
      foundation (model + service + admin API + UI) is now done. ~19 files
      reference `buyRate`/`sellRate` across models, routes, services, and
      both frontends (user-panel, admin-panel).

## AFTER THAT — Revenue & Settlement Platform scoped

- [ ] **Merchant commission payout engine.** How/when a merchant actually
      gets paid `merchantCommissionPercent` from platform funds — new
      `Transaction` type(s), ledger entries via `walletAuthority.service.js`,
      timing (per-order vs. batched settlement). Natural home: a new
      `domains/settlement/` or `domains/revenue/` module, not bolted onto
      `merchant.routes.js`.

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
