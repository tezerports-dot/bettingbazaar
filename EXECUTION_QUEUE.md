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

## DONE — 2026-07-08

- [x] **Correction:** removed `DepositPolicy.merchantCommissionPercent` /
      `commissionFundingSource` entirely (schema, service validation/create/
      rollback, admin route body+audit-log, `paymentOrder.model.js`
      `depositPolicySnapshot` + pre-save hook, admin-panel types/api/UI).
      Deposit creation and a completed buy+sell cycle are different trigger
      events — merchant incentive pay cannot live on a deposit-triggered
      policy. Safe: no code consumed these fields, no `DepositPolicy`
      document exists yet in the live DB. See ENTERPRISE_DECISIONS.md.
- [x] Wired `applyScheduledPolicyChanges()` and `applyScheduledConfigChanges()`
      into `cronJobs.js` (60s interval, same dynamic-import pattern as the
      order expiry worker). Per-item failures logged, never thrown.
- [x] **buyRate/sellRate → 1:1 flattening — COMPLETE.** Five slices, each a
      commit on `main`: (1) order-creation math (rateUsed=1, fiat=tokens,
      merchantProfit=0), (2) public rate surfaces → constant 1/1/0 with
      shapes kept for client compat, (3) user-panel + merchant-panel UI,
      (4) admin token-rates routes + admin page removed, (5) `TokenRates`
      model removed (`'TokenRates'` kept in ConfigVersion enum for
      historical audit docs; `migrate-wallet-system.js` deleted per §13).
      04-GOVERNANCE.md §1/§2/§14 updated. See ENTERPRISE_DECISIONS.md.

---

## NEXT — per established dependency order (not an open choice)

- [ ] **Phase 007 — Operations Platform.** Orchestration-only admin control
      center; owns NO data (2026-07-03 decision). First 006-exit criterion
      work is done; this is the next roadmap phase.

## AFTER THAT — Merchant Platform / Revenue & Settlement Platform scoped

- [ ] **Merchant Performance Bonus engine.** 2026-07-08 decision: a
      cycle-completion-triggered (not deposit-triggered), platform-funded
      operating expense — `merchantBonusPercent` of completed buy→sell cycle
      volume, never deducted from users/deposits/withdrawals. Needs a Cycle
      Tracker → Bonus Calculator → Bonus Ledger (Merchant Platform, per
      ENTERPRISE_DECISIONS.md), new `Transaction` type(s), ledger entries via
      `walletAuthority.service.js`, and a timing decision (per-cycle vs.
      batched settlement). Natural home: `domains/merchant/` bonus
      sub-module or a new `domains/settlement/`/`domains/revenue/` module —
      not bolted onto `merchant.routes.js`. Slots in after 1:1 buyRate/
      sellRate flattening per the dependency chain in
      ENTERPRISE_DECISIONS.md.

---

## KNOWN OPEN ITEMS (not urgent, not forgotten — see PHASE_STATUS.md for full detail)

- [ ] Reroute `merchant.routes.js` wallet-balance writes through
      `walletAuthority.service.js` (currently raw `$inc` — pre-existing
      §7 violation, not introduced by or fixed in this migration).
- [ ] Remove or repurpose `paymentProcessing.service.js`'s orphaned
      `approveDeposit()` (dead code, never called).
- [ ] Merchant `maxConcurrentOrders` production backfill confirmation.
- [ ] `PaymentGatewayConfig` — confirmed intentional future scaffolding, not
      yet wired in.
- [ ] `backend/debug-merchant-query.mjs` / `check-merchants.mjs` — stray,
      unimported debug scripts, safe to delete.
- [ ] `deposit-policy-migration.patch` (repo root) — a stale, committed patch
      file describing the now-removed `merchantCommissionPercent`/
      `commissionFundingSource` fields. Violates 04-GOVERNANCE.md §13 ("no
      committed artifact may describe a pending fix that is not yet
      applied" / patch files must not live in the repo root). Not deleted
      here — out of scope for this task, flagged instead per the "never
      silently fix out-of-scope issues" rule.
- [ ] **Discovered 2026-07-08:** merchant-panel `npm run build` is broken in
      the pristine repo — its build script is `tsc && vite build` and `tsc`
      fails with 20 pre-existing errors (OrderCard null-safety, unused
      imports, etc.). `vite build` alone succeeds. Not introduced by and not
      fixed in the 1:1 flattening (verified identical error list before/
      after); needs its own cleanup pass.
- [ ] **Discovered 2026-07-08:** the user panel has ~95 pre-existing
      `tsc --noEmit` errors (two of which — broken `TokenRates` type imports
      — the 1:1 flattening incidentally fixed). Vite builds fine; type
      cleanup is a separate task.
- [ ] Old `tokenrates` Mongo collection still exists with historical data;
      nothing reads or writes it since the TokenRates model removal. Drop it
      during a scheduled DB maintenance window if desired (DB operation, not
      a code change).
