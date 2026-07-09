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

## NEXT — Phase 007: Revenue & Settlement Platform bootstrap (owner directive 2026-07-09)

Phase renumbered 2026-07-09: 007 is now the R&S Platform bootstrap; the
Operations Platform (orchestration-only) slots later. See ENTERPRISE_DECISIONS.md.

- [x] Ledger core: `domains/revenue/` — chart of accounts, append-only
      double-entry `AccountingEvent` model (integer paise, unique idempotency
      keys, immutability middleware), sole-writer
      `revenueSettlement.service.js` with pure posting builders (deposit /
      withdrawal / cycle / bonus funding, incl. historical-rate residuals).
      Verified with 34-assertion control-flow tests against the real code.
- [x] Reconciliation worker in `cronJobs.js` (60s): derives ledger entries
      from COMPLETED PaymentOrders and settled Cycles, idempotent, per-item
      failures logged never thrown, history backfills automatically.
- [x] Admin surface: GET /api/admin/revenue/summary (trial balance +
      distributable revenue + integrity check), GET .../ledger (paginated),
      POST .../bonus-pool/fund (explicit amount + businessJustification,
      capped at distributable revenue, audit-logged). Mounted via
      routes/admin/index.js.
- [x] 04-GOVERNANCE.md §1: AccountingEvent / settlement-ledger authority row.

**Phase 007 bootstrap complete (2026-07-09).**

## PHASE 008 — Merchant Platform (owner directive 2026-07-09) — COMPLETE

- [x] R&S ledger side: MERCHANT_FUNDS account + issueMerchantBonus()
      (pool-capped, idempotent).
- [x] MerchantBonusPolicy in Business Policy Platform (whole-doc versioned,
      immediate-apply v1, disabled by default, admin routes + audit).
- [x] merchantWallet.service.js — sole Merchant.tokenBalance writer;
      all 7 raw $inc sites rerouted; MerchantWalletLedger; canonical
      per-operation txIds give cross-route double-deduction protection.
- [x] Merchant Performance Bonus Engine (Cycle Tracker → Bonus Calculator →
      issuance) + 10-min cron + POST /api/admin/merchant-platform/
      bonus-engine/run. 7 control-flow assertions on the calculator.
- [x] Merchant analytics: leaderboard, funding stats, performance history,
      wallet ledger admin API; platform README.

## PHASE 012 — Enterprise Experience (owner directive 2026-07-09) — IN PROGRESS

- [x] Communication Platform: notify() engine + channel adapters (IN_APP
      live; EMAIL/SMS/PUSH declared inactive), Audit Feed + Admin Activity
      Feed APIs, admin.service.js's four direct Notification.create sites
      rerouted; governance §1 row.
- [ ] Operations Platform: enterprise overview + config catalog (next).
- [ ] Reporting Platform: financial/merchant/settlement reports + CSV
      regulatory export.
- [ ] Analytics Platform extension; Enterprise UI/UX (admin consoles for
      the new platform APIs, user-panel polish) — large, own slices.

### Deferred within 012 (so far)
- [ ] Remaining direct Notification.create writers outside admin.service.js
      (if any appear) → notify().
- [ ] EMAIL/SMS/PUSH channel implementations (need provider credentials
      config in Business Policy first).
- [ ] Internal messaging (P2P chat/system messages) consolidation under
      Communication — opportunistic.

## PHASE 011 — Product Platforms (owner directive 2026-07-09) — COMPLETE

- [x] Markets Platform: domains/game + domains/betting → domains/markets
      (git mv, imports updated, module graph verified).
- [x] Casino Platform: gameProvider model + routes → domains/casino
      (git mv, relative imports fixed, full server boot verified).
- [x] Shared trading models (domains/trading) consumed by Markets + Risk;
      settlement-integration contract documented.
- [x] Sportsbook/Games/Event/Odds boundaries declared + feature flags
      (SPORTSBOOK, GAMES_PLATFORM, EVENT_FEEDS, ODDS_ENGINE, LIVE_CASINO).
- [x] Four-tier architecture recorded as the final structure.

### Deferred within 011
- [ ] Casino GGR ledger integration: derive R&S entries from
      GameTransaction records (reconciler pattern, new event type + casino
      accounts in the chart) — do BEFORE activating a live provider.
- [ ] gameEngine.js internal status strings → tradingModels constants
      (opportunistic; queries are correct today).
- [ ] domains/settlement/ (batch executor) fold into markets or wallet
      opportunistically.

## PHASE 010 — Risk Platform (owner directive 2026-07-09) — COMPLETE

- [x] domains/risk/riskValidation.service.js — single validation authority:
      positive/numeric, multiples-of-10 (riskRules.enforceMultiplesOf10,
      default ON per directive — NOTE: this is a live behavior change; a
      user can no longer buy/sell/bet non-multiples of 10), limits,
      reserve-split rounding (moved from paymentOrder pre-save),
      opposite-side restriction (default off), funding velocity (default
      off), payout-fee arithmetic.
- [x] Wired: paymentProcessing deposit/withdrawal creation, bet.routes.js
      placement, paymentOrder.model.js reserve split.
- [x] Configurable payout fee: SystemConfig.payoutFeePercent (default 0),
      order.payoutFee, withdrawal fiat = tokens − fee, ledger posts the fee
      to PAYOUT_FEES (its first real producer). GET/PUT /system/config
      exposes payoutFeePercent + riskRules.
- [x] 04-GOVERNANCE.md §1 row: Risk Platform validation authority.
- [x] 25 control-flow assertions on the real validators + fee postings.

### Deferred within 010 (flagged, not forgotten)
- [ ] AML screening, fraud-signal scoring, device risk, behaviour analysis,
      responsible-gaming limits — declared Risk capabilities, deliberately
      not stubbed (no fake placeholders).
- [ ] Frontend UX for multiples-of-10 (step hints/validation messages in
      WalletModal/WalletPage/bet UI) — server rejects with clear messages
      today; client polish is Phase 012 scope.
- [ ] Admin-panel UI for riskRules/payoutFeePercent (API-only today).
- [ ] DepositPolicy.reserveUsageRules enforcement — rules are modeled;
      Risk enforces when a reserve-consuming flow ships.

## PHASE 009 — Funding Platform (owner directive 2026-07-09) — COMPLETE

- [x] `domains/funding/`: fundingAuthority.service.js (single money-movement
      entry), providerRegistry.js (MANUAL_P2P_INR live; USDT_TRC20 +
      PAYMENT_GATEWAY declared inactive adapters), fundingEvents.js (eventBus
      wired: created events from the facade; completed events from the two
      live completion routes → immediate ledger reconciliation).
- [x] payment.routes.js deposit/withdrawal creation rerouted through the
      facade; subscribers registered at startup in server.js.
- [x] 04-GOVERNANCE.md §1 rows: merchant wallet, funding authority,
      MerchantBonusPolicy.

### Deferred within 009
- [ ] USDT Treasury build (address mgmt, TRC20 confirmation watching,
      1:1 INR-peg crediting) to activate the USDT_TRC20 adapter.
- [ ] PAYMENT_GATEWAY adapter implementation against a real gateway
      (PaymentGatewayConfig scaffolding exists).
- [ ] Publish PAYMENT_ORDER_COMPLETED from the remaining completion paths
      (dispute-resolution, payment.routes confirm) — cron covers them today.

### Deferred within 008 (flagged, not forgotten)
- [ ] MerchantBonusPolicy v1 has no scheduling/approval lifecycle (mirror
      depositPolicy.service.js when needed).
- [ ] Two historically blind merchant-wallet debit sites run with
      allowOverdraft to preserve behavior (merchant confirm, dispute
      release) — decide whether to make them strict.
- [ ] No admin-panel UI for MerchantBonusPolicy / merchant-platform
      analytics yet (API-only).

### Deferred within 007 (flagged, not forgotten)
- [ ] Reconciler anti-join scans all completed sources each pass — add a
      checkpoint/high-water-mark optimization when volume warrants.
- [ ] `fundMerchantBonusPool` distributable check is read-then-write (no
      cross-document transaction) — fine while funding is a rare manual
      admin action; revisit before automated policy-driven funding.
- [ ] MerchantBonusPolicy (Business Policy Platform sibling) to automate
      funding percentage/cadence; Merchant Performance Bonus issuing engine
      (Cycle Tracker → Bonus Calculator → Bonus Ledger) consumes the pool.
- [ ] PAYOUT_FEES account + PAYOUT_FEE_CHARGED event type are defined with
      no producer — the fee itself doesn't exist yet; Business Policy will
      define it. Intentional registry entry, not an orphan.

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
