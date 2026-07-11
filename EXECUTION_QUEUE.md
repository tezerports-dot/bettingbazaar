# Execution Queue — Phase 006 (Business Policy Platform)

**Purpose:** the ordered/optional-ordered list of concrete next tasks, so a
session can pick up work without re-deriving "what's next" from scratch. This
file didn't exist before 2026-07-07; created as part of the DepositPolicy
migration.

Completed items are kept (struck through in spirit, marked DONE) rather than
deleted, so this file also works as a short-form recent-history log.

---

## DONE — 2026-07-11 (Business Config Audit + queue drain)

- [x] **Business Configuration Audit** — every business rule now flows from
      SystemConfig with an admin UI, DB persistence, runtime read, and no silent
      hardcoded fallback. Moved four formerly-hardcoded values into config and
      wired their consumers: `payoutMultiplier` (was `×2` in gameEngine →
      Risk.computeWinningsPayout), `orderExpiryMinutes` (was `15*60*1000` in
      paymentProcessing), `riskRules.maxWarnings` (was `WARNING_THRESHOLD=3` in
      merchant reject), `cyclePhases` (was inline 3m/2m/30s/10s in cycleGenerator,
      now a cached read). Admin GET/PUT + validation + SystemSettings UI +
      config-catalog entries + versioned writes via setConfigField. Corrected a
      stale catalog comment claiming `payoutMultiplier` "never existed", and the
      user-panel game-config response that hardcoded `payoutMultiplier: 2`. New
      unit tests (multiplier arithmetic) + a gameEngine integration test
      (3× payout). Full write-up in **BUSINESS_CONFIG_AUDIT.md**.
- [x] **App-asset uploads → S3** (portability): `cdn.service.uploadBufferToS3` +
      `isS3Configured`; new `AppAsset` metadata model (multi-instance source of
      truth); the three `/app-assets` handlers rewritten to use S3-when-configured
      with a local-disk fallback. Fixed a latent bug: those handlers referenced
      `ASSET_SLOTS`/`appAssetsDir_r` declared only in system.admin.routes.js
      (different module) — would have thrown at request time. Removed that dead
      block from system.admin.routes.js (§13).
- [x] **User.email profile field + API** and **merchantScoring stale-comment
      cleanup** — see the two items under "Discovered during Phases B–F" below.

---

## DONE — 2026-07-10 (PHASES B–F, same session as Phase A)

- [x] **F-2** — settlement locked-balance writes rerouted through the new
      `walletAuthority.releaseLockedStake()` (transaction + unique-txId race
      gate; the win-path unlock previously had NO idempotency guard at all).
      `WalletLedger.field` gains 'lockedBalance' (honest unlock records).
      Cycle totals now DERIVED from stamped WON bets (crash-resume-correct).
      Proven by settlementConcurrency.integration.test.js: two concurrent
      passes, full re-run, partial-crash resume.
- [x] **F-3** — Redis-backed rate limiting: all six limiters share counters
      across instances via middleware/redisRateLimitStore.js (atomic Lua
      INCR+PEXPIRE, per-instance memory fallback when Redis absent/down).
      CI proves cross-instance sharing against a real redis:7 service.
- [x] Merchant token-**deduction** admin control: POST
      /api/admin/merchants/:id/deduct (strict no-overdraft, reason required,
      audit-logged) + MerchantsList UI.
- [x] Withdrawal-lifecycle + merchant-bonus integration tests
      (withdrawalBonus.integration.test.js): lock/approve/reject idempotency,
      pool caps, two-step issuance replay with zero double-pay.
- [x] §13 cleanup: migrations 001/002, debug-merchant-query.mjs,
      deposit-policy-migration.patch deleted (all marked applied/safe).
- [x] **Phase C admin consoles:** /revenue (ledger + bonus-pool funding),
      /operations (overview + config catalog + audit feed), /reports
      (financial/settlement/merchant + regulatory CSV), /merchant-platform
      (MerchantBonusPolicy editor, leaderboard, wallet ledgers, engine run);
      System Settings gains all money knobs with plain-English explanations
      + live worked examples; merchant deduct UI. tsc + vite green.
- [x] Winner board bug: /api/v1/winners queried isWinner/winAmount — fields
      that never existed on Bet — so REAL winners never showed. Fixed to
      status:'WON' + payout with cycle context.
- [x] **Phase D:** recover-account link on the auth modal (flow existed,
      nothing linked to it); ResultsPage 3-4/screen cards → 12-15/screen
      dense rows; sticky game header (the "header hides" issue).
- [x] **Phase E:** real SMTP EMAIL channel adapter, activation-gated on env
      (SMTP_HOST/PORT/USER/PASS/FROM) — no fake code, no hardcoded provider;
      optional User.email field. SMS/PUSH/USDT/gateway/Telegram documented
      with exact activation steps in PRODUCTION_READINESS.md.
- [x] **Phase F (in-repo):** bcrypt cost 10→12 standardized (M-2 — admin
      service + sub-admin route), Mongo pool sizing via env, and
      PRODUCTION_READINESS.md (owner checklist: secret rotation, licensing,
      pentest, load test, backups + per-integration activation guides).

## PHASE X — Enterprise Validation & Hidden Workflow Audit (2026-07-10) — see AUDIT_PHASE_X.md

Systematic architectural audit (not feature work). Findings, highest value first:

**FIXED 2026-07-10 (same session):** X-1/X-2/X-3 (reserve now funded on both
deposit paths via the wallet authority; approve rerouted off raw $inc — Known
Open #6 closed), X-4 (cron leader election), X-5 (cycle duration configurable),
X-9 (assignment-race test). Remaining open: X-6 observability, X-7 data
lifecycle, X-8 authz matrix. See AUDIT_PHASE_X.md for the fix commits.

- [x] **X-1/X-2 (🔴) Two divergent deposit-completion endpoints. — FIXED**
      `/merchant/confirm/:id` credits full tokenAmount to deposit (NO reserve
      split); `/merchant/orders/:id/approve` applies the DepositPolicy split.
      The panel exposes both. If the live path is `/confirm`, the reserve
      wallet is never funded → DepositPolicy + Phase A betReservePercent are
      effectively dead for real deposits, and the derived ledger (which always
      posts the reserve allocation from the order) disagrees with the actual
      wallet. NEEDS A PRODUCT DECISION on the canonical path, then align/remove
      the other + integration test that a completed deposit funds reserve.
- [ ] **X-3 (🟠) approve path credits user via raw $inc.** Bypasses
      walletAuthority.creditDeposit/creditReserve (§7 + Known Open #6): no
      idempotency key backstop (only the status guard prevents double-credit),
      and safeSession() degrades non-atomic on standalone Mongo → crash mid-way
      leaves order COMPLETED but user un-credited, unrecoverable. Fix: reroute
      through the authorities with the route session; test double-approve.
- [ ] **X-4 (🟠) cron jobs have no leader election.** All setInterval in
      cronJobs.js; every replica runs every job. Safe today only via per-job
      idempotency. Needs a Mongo/Redis leader lock before >1 instance (same
      cluster as the SSE-bridge item).
- [ ] **X-5 (🟡) cycle duration hardcoded** (30*60*1000, cycleGenerator:424) —
      move to SystemConfig, read in generator + GAME_CORE mirror, add to catalog.
- [ ] **X-6 (🟡) observability** — request/correlation IDs, structured logging,
      metrics/alerting (owner: alert on ledger integrityOk:false).
- [ ] **X-7 (🟡) data lifecycle** — retention/archival plan per unbounded
      collection (AccountingEvent/WalletLedger/Bet/Transaction/audit), soft-delete
      convention.
- [ ] **X-8 (verify) authz matrix** — build the full endpoint×role×ownership
      table (per-route auth confirmed present at spot-checks; no hole asserted).
- [ ] **X-9 (verify) merchant-assignment concurrency test** — prove the
      two-merchants-same-order loser is rejected (settlement race already proven).

### Discovered during Phases B–F (queued)

- [x] **SSE/socket fan-out** — DONE 2026-07-10. startup/realtimeBridge.js:
      socket.io Redis adapter + a Redis pub/sub relay in SSEManager fan
      real-time events across all instances (origin-dedup, graceful no-Redis
      fallback), proven cross-instance in CI. The app tier is now horizontally
      scalable.
- [x] **DONE 2026-07-11.** User panel profile field + API for the optional
      `User.email` — ProfilePage → Edit Profile now has a validated Email field;
      `PUT /user/:userId/profile` accepts/validates `email`; both profile GETs
      return it.
- [x] **DONE 2026-07-11.** merchantScoring.service.js stale
      `migrations/003-backfill-merchant-defaults.js` comment removed (the query
      fix is self-contained defense-in-depth; no migration file exists).

---

## DONE — 2026-07-10 (PHASE A: betting-logic correctness & admin-configurability)

- [x] **Step 0 — integration suite resurrected for real.** Discovered that CI
      had NEVER been green: every run since the suite was added failed its
      integration step (the tests were written where mongod couldn't run and
      pushed unverified). Four test-code root causes fixed (JWT_SECRET missing
      in test env; ledger test cleanup tripping the append-only middleware;
      Merchant fixtures missing required `name`; gameEngine test asserting a
      nonexistent `walletBalance` field; auth test mounting the router at the
      wrong path + expecting 400 where the route returns 409). **CI run #10 =
      the first green CI in this repo's history.** No product code changed.
- [x] **Bet-funding split admin-editable + paise-exact.**
      `SystemConfig.betReservePercent` (default 3 = historical 97/3), admin
      GET/PUT with validation, versioned via setConfigField.
      `riskValidation.computeBetFundingPlan()` is the arithmetic authority:
      integer paise + basis points, reserve floored/remainder to main
      (conserves the stake exactly), fallbacks preserved (reserve short →
      main, deposit first then winnings), drained buckets returned as the
      caller's float verbatim so the route's atomic `$gte` guard can't
      spuriously fail. Fixed en route: the old `Math.round` pair could
      OVER-DEDUCT — a ₹50 bet took 49+2 = ₹51 while locking 50.
- [x] **1% winnings platform fee implemented (owner spec §6).**
      `SystemConfig.winningsFeePercent` (default 1 — deliberate live behavior
      change per the Phase A directive; 0 restores flat 2x), admin GET/PUT.
      `riskValidation.computeWinningsPayout()`: fee floored in paise, never
      rounds up against the user; net+fee === gross exactly. gameEngine pays
      NET, stamps `Bet.payout`/`Bet.platformFee`, snapshots
      `Cycle.totalPlatformFees`/`winningsFeePercentUsed`. Ledger unchanged:
      the retained fee is inside netProfit → PLATFORM_REVENUE via the
      existing BET_CYCLE_SETTLED posting; itemized in event metadata.
- [x] **Tests:** 17 new unit tests (68 total green) incl. conservation
      property sweeps; gameEngine integration tests assert net payout,
      stamped fee, paise case (₹10 → 19.80/0.20), and fee=0 → flat 2x;
      new `betFlow.integration.test.js` runs the WHOLE flow through the real
      route + engine + reconciler — balanced cycle where PLATFORM_REVENUE
      equals exactly the retained fee, insufficient-balance rejection, and
      both funding fallbacks.

### Discovered during Phase A (queued, not silently fixed)

- [ ] **Settlement recovery totals (Phase B, F-2-adjacent):** if
      `processPayoutsOptimized` crashes mid-batch, the recovery re-run
      aggregates only still-PENDING bets, so `Cycle.totalPaidOut`/`netProfit`/
      `totalPlatformFees` would reflect only the tail of the payout (wallet
      credits themselves are idempotent and safe). Fold into the F-2
      settle-under-concurrency integration work.
- [ ] `backend/migrations/002-fix-everything.js` still computes `bet.amount*2`
      — marked-applied migration that §13 says should be deleted after prod
      confirm; now also stale vs the fee logic. Delete with the other applied
      migrations.
- [ ] Frontend surfaces that display payouts as flat 2x (user-panel copy,
      admin winner board) need the net-of-fee numbers — fold into Phase C/D
      UI work (backend payloads already carry the real values).

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
- [x] Operations Platform: GET /api/admin/operations/overview (settlement/
      treasury/funding/risk/policy/merchant/communication/flag monitoring,
      all read live from owning platforms) + /operations/config-catalog
      (every configurable value → owning authority → edit endpoint).
- [x] Reporting Platform: financial / settlement / merchant reports +
      regulatory ledger CSV export (one row per journal posting), all
      derived read-only from the settlement ledger and orders.
- [x] Analytics Platform extension: GET /api/admin/analytics/trends —
      growth (signups, first-time depositors), business (betting +
      funding volume), revenue (from the settlement ledger), risk
      (failure/dispute signals); extends the existing analytics domain.
- [ ] Enterprise UI/UX: admin-panel consoles for the Phase 007-012 APIs
      (revenue, bonus policy, merchant platform, operations overview,
      config catalog, reports, audit feeds), user-panel polish incl.
      multiples-of-10 hints — the largest remaining 012 item.

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

## AUDIT (2026-07-09) — hardening pass toward production

- [x] Dead test suite resurrected (vitest config pointed at nonexistent
      server/tests/**). 50 unit tests green in-sandbox; integration tests +
      GitHub Actions CI added (integration runs where mongod is reachable).
- [x] §7 fix: reserveBalance was credited via raw $inc with NO ledger trail
      in payment.routes.js and paymentProcessing.service.js. Added
      walletAuthority.creditReserve (idempotent, ledgered); both sites
      rerouted; integration test added.
- [x] Scale: added missing User indexes (referredBy, kycStatus, username,
      createdAt) — were full-scanning.

### AUDIT — still open (tracked, not silently skipped)
- [ ] settlementService.js raw $inc on lockedBalance/lockedDepositAmount/
      lockedWinningsAmount (lines ~12, ~27) — the settlement hot path.
      Delicate; should be rerouted through a walletAuthority unlock method
      WITH an integration test that runs the full settle flow under
      concurrency, not changed blind. Highest-priority remaining money fix.
- [ ] Redis-backed rate limiting: current limiter is in-memory, so it does
      nothing across horizontally-scaled replicas (REDIS_RATE_LIMITER flag
      is off). Required before running >1 backend instance.
- [ ] Full auth/authz line-by-line audit + dependency audit (npm audit
      reports 13 vulns in the newly added dev tooling — review prod deps).
- [ ] admin-panel / merchant-panel tsc build breakage (pre-existing) blocks
      full CI build gating.
