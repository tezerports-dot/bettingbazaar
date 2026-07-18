# Phase Status — Canonical Project State

**This file, not conversation history, is the source of truth for project state.**
Update it after every significant change. If this file and a chat summary disagree,
this file wins — that's the point of it existing.

Last updated: 2026-07-10

---

## BBEPS Phase Status

| Phase | Status | Evidence |
|---|---|---|
| 0 — Repository Baseline Assessment | Locked | audit/PHASE0_BASELINE_AND_FINDINGS.md |
| 002 — Capability Inventory | Locked (one open caveat) | Capability table in Phase 0 doc; "no orphaned functionality" being closed incrementally as each domain migration traces its own files |
| 003 — Domain Discovery & Bounded Contexts | Substantively complete | 13 domains with real code have enforced bounded contexts |
| 004 — Target Enterprise Architecture | Decision locked, execution complete for existing code | backend/domains/ + backend/shared/ inside the existing app |
| 005 — Technology Strategy | Corrected 2026-07-03 | Originally under-scoped (language choice only). Now includes real research: Provider/Adapter pattern and Policy/Rules-Engine pattern both confirmed as standard, industry-proven fits for this platform. See FUTURE_CAPABILITIES.md architecture decision. |
| 006 — Configuration Engine / Business Policy Platform | Core complete (2026-07-08) | DepositPolicy vertical slice (model/service/admin API/UI, wired into real runtime consumers) shipped 2026-07-07; scope corrected 2026-07-08 (merchant commission fields removed — deposit-triggered policy can't own cycle-triggered incentive pay); scheduled-apply wired into `cronJobs.js` (60s); **buyRate/sellRate fully flattened to fixed 1:1 and `TokenRates` removed (2026-07-08)**. Renamed in direction to Business Policy Platform per 2026-07-03 decision. Future sibling policies (Withdrawal/Risk/Merchant/Settlement) remain open Business Policy Platform work, but the 006 exit criteria are met. |
| 007 — Revenue & Settlement Platform (bootstrap) | **Bootstrap complete (2026-07-09)** | **Renumbered by owner directive 2026-07-09** (was "Enterprise Control Center / Operations Platform" — that remains orchestration-only and slots later; see ENTERPRISE_DECISIONS.md). `domains/revenue/` — the single financial authority: append-only double-entry settlement ledger (`accountingEvent.model.js`, integer paise, unique idempotency keys, immutability middleware), closed chart of accounts, sole-writer `revenueSettlement.service.js` owning completed bets/payouts, platform revenue, reserve deductions, payout fees, accounting events, and merchant bonus funding. Ledger is DERIVED: a 60s reconciliation worker (cronJobs.js) anti-joins completed PaymentOrders + settled Cycles and records what's missing — no live money flow was modified; history backfills automatically. Admin surface: /api/admin/revenue/summary, /ledger, /bonus-pool/fund (platform-funded only, capped at distributable revenue, audit-logged). New §1 authority row in 04-GOVERNANCE.md. Verified: 34-assertion control-flow tests on the real posting builders. Remaining 007-adjacent work (bonus issuing engine, MerchantBonusPolicy) tracked in EXECUTION_QUEUE.md. |
| 008 — Merchant Platform | **Complete (2026-07-09)** | Renumbered by owner directive (old "Financial Core" scope was partially absorbed into 007; its remainder is queued). Delivered: Merchant Performance Bonus Engine (matched buy→sell cycle volume, ledger-derived high-water marks, pool-capped idempotent issuance, 10-min cron + on-demand admin trigger), MerchantBonusPolicy (Business Policy Platform, disabled by default), `merchantWallet.service.js` as sole `Merchant.tokenBalance` writer (all 7 raw `$inc` sites rerouted with a MerchantWalletLedger + cross-route idempotency), merchant analytics/leaderboard/funding-stats/performance-history admin API, platform README. |
| 009 — Funding Platform | **Complete (2026-07-09)** | Renumbered by owner directive. `domains/funding/` — the only authority for money movement: `fundingAuthority.service.js` (single entry for deposits/withdrawals, intent-based), `providerRegistry.js` (adapter pattern — MANUAL_P2P_INR live; USDT_TRC20 and PAYMENT_GATEWAY declared inactive), `fundingEvents.js` (first real eventBus wiring: order-created published by the facade, order-completed published at live completion points and consumed to nudge the R&S ledger reconciler within seconds). Creation routes rerouted through the facade. Never owns accounting. Old "Workflow Engine" scope re-queued. |
| 010 — Risk Platform | **Complete (2026-07-09)** | Renumbered by owner directive (old "Event Architecture" scope: eventBus genuinely wired by Phase 009). `domains/risk/riskValidation.service.js` — single validation authority: positive/numeric/multiples-of-10 (config-gated, default ON per directive), min/max limits, reserve-split rounding (Spec 4.4, moved here from paymentOrder pre-save), opposite-side betting restriction (config-gated, default off), funding velocity limits (default off), payout-fee arithmetic (SystemConfig.payoutFeePercent, default 0 — first real PAYOUT_FEES ledger producer). Wired into deposit/withdrawal creation, bet placement, and the reserve split. AML/fraud/device/behaviour declared, not faked — queued. 25 control-flow assertions pass. |
| 011 — Product Platforms | **Complete (2026-07-09)** | Four-tier architecture accepted (Core Enterprise / Product / Customer / Enterprise Services — see ENTERPRISE_DECISIONS.md). Real consolidation: `domains/markets/` (git mv of game + betting — the cycle-market product unified), `domains/casino/` (git mv of gameProvider model + routes), `domains/trading/tradingModels.js` (canonical vocabulary consumed by Markets + Risk, settlement-integration contract documented). Sportsbook/Games/Event/Odds declared with boundary READMEs + feature flags (all default off), no fake code. Runtime-verified incl. an accidental full server boot. |
| 012 — Enterprise Experience | **IN PROGRESS (2026-07-09)** | Shipped: Communication Platform (notify() engine + channel adapters, IN_APP live, audit + admin-activity feeds), Operations Platform (orchestration-only enterprise overview + the config catalog enforcing no-hardcoded-values), Reporting Platform (financial/settlement/merchant reports + regulatory ledger CSV export), Analytics Platform trends (growth/business/revenue/risk, day-bucketed). Remaining: Enterprise UI/UX (admin consoles for all Phase 007-012 APIs, user-panel polish), performance/production hardening, inactive-channel/provider implementations. |
| 011 — Algorithm Registry | Not started | Merchant scoring has real docs post-bugfix; reinforced (not replaced) by the platform-architecture decision |
| 012 — Business Process Catalog | Not started | — |

---

## Domain Migration Status

**Migrated (14):** Revenue (new domain, Phase 007 — not a migration but a
platform bootstrap, listed here so the domain count stays honest), Merchant,
Payment, Configuration, Wallet, Betting, Game, Identity,
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
   idempotency keys, not atomicity. Documented, not changed; this remains a
   deployment-readiness hardening item before high-volume automated settlement.
4. `backend/debug-merchant-query.mjs` and `check-merchants.mjs` — removed; no
   stray debug scripts remain in the repo.
5. Phase 002 "no orphaned functionality" — verified at capability level only.
6. Core Infrastructure Architecture is planned as a future licensed-operator
   infrastructure track: L4-multiplexed SNI passthrough, E2EE preservation, and
   transparent PROXY protocol v2 client-IP preservation must be evaluated with
   legal, regulatory, provider-contract, abuse-monitoring, observability, and
   trusted-proxy validation review before rollout.
7. **Closed after 2026-07-07 discovery:** live merchant deposit approval/confirm
   paths now credit users through `walletAuthority.service.js`; the orphaned
   `paymentProcessing.service.js` `approveDeposit()` helper has been removed.
8. **Corrected 2026-07-08 (was: "New with this migration" 2026-07-07):**
   `DepositPolicy.merchantCommissionPercent` / `commissionFundingSource` have
   been **removed** — deposit creation and a completed buy+sell cycle are
   different trigger events, so merchant incentive pay cannot live on a
   deposit-triggered policy. Removed from the schema, service (validation,
   create, rollback), admin route, `paymentOrder.model.js`'s
   `depositPolicySnapshot`, and the admin-panel DepositPolicy page. Safe: no
   code ever consumed these fields and no `DepositPolicy` document exists in
   the live DB. The replacement mechanism — "Merchant Performance Bonus",
   triggered by completed buy+sell cycles, platform-funded — is not yet
   modeled anywhere; see ENTERPRISE_DECISIONS.md 2026-07-08 and
   EXECUTION_QUEUE.md.
9. **Found and fixed while verifying runtime consumers (2026-07-07):** a
   third independent hardcoded 90/10, in `paymentProcessing.service.js`'s
   `createDepositOrder()` — it computed `depositAllocation`/`reserveAllocation`
   locally (redundant with, and silently overwritten by, the model's pre-save
   hook), then built the user-facing order confirmation `note` string from
   those stale local variables rather than the actual post-save values. A
   real (if minor) bug: if an admin had set a non-90/10 DepositPolicy, the
   confirmation message shown to the depositing user would describe the
   wrong split, even though the order itself was allocated correctly. Fixed
   to read `order.depositAllocation`/`order.reserveAllocation` after
   `order.save()`.

---

## Current Active Phase

**Phases A–F implementation substantially complete in-repo (2026-07-10), with tracked follow-up work.** The roadmap details below record completed scope while leaving owner-action and queued engineering items as the authoritative remaining work:

- **Phase B:** F-2 (settlement unlocks via walletAuthority, transactional +
  idempotent, concurrency/crash-resume proven in CI), F-3 (Redis-shared
  rate limiting, proven against real Redis in CI), merchant token-deduction
  control, withdrawal + bonus integration coverage, §13 artifact cleanup.
- **Phase C:** admin consoles for every Phase 007–012 API (/revenue,
  /operations, /reports, /merchant-platform), money-rule settings with
  plain-English explanations + live examples, merchant deduct UI, winner
  board real-winner fix (queried fields that never existed on Bet).
- **Phase D:** recover-account entry on auth modal, dense results list
  (12-15/screen), sticky game header.
- **Phase E:** real env-gated SMTP EMAIL adapter (active the moment
  SMTP_* env vars are set); SMS/PUSH/USDT/gateway documented with
  activation steps (need owner credentials).
- **Phase F:** bcrypt-12 standardization and an env-tunable Mongo pool.

**Remaining work is tracked follow-up:** see EXECUTION_QUEUE.md "Discovered during Phases B–F" for owner-action items, queued polish, and scale work such as the SSE/socket Redis bridge before >1 instance.

### Phase A record (same day)

Betting-logic correctness & admin-configurability:

- **Step 0:** the integration test suite had NEVER passed in CI (every run
  failed on test-code bugs — see EXECUTION_QUEUE.md 2026-07-10). Fixed;
  CI run #10 is the repository's first green run. All money-flow claims
  below are CI-proven, not static-check-proven.
- **Bet-funding split:** `SystemConfig.betReservePercent` (default 3 =
  historical 97/3), admin-editable; arithmetic single-sourced in
  `riskValidation.computeBetFundingPlan()` — paise-exact, conserves the
  stake (the old rounding could deduct ₹51 for a ₹50 bet), fallbacks kept.
- **Winnings platform fee:** `SystemConfig.winningsFeePercent` (default 1
  per owner spec §6 — live behavior change), admin-editable; arithmetic in
  `riskValidation.computeWinningsPayout()` (fee floored, net+fee===gross);
  engine pays NET, stamps Bet.payout/platformFee, snapshots cycle fee
  totals; fee reaches PLATFORM_REVENUE inside netProfit via the existing
  BET_CYCLE_SETTLED posting (decision log 2026-07-10).
- **Proof:** 68 unit tests + end-to-end betFlow integration test (real
  route → real engine → real ledger; balanced cycle where platform revenue
  equals exactly the retained fee).

**Phase B follow-up record (historical open items, now tracked in EXECUTION_QUEUE.md):**
The Phase A handoff identified F-2 settlementService raw `$inc` reroute with a
settle-under-concurrency integration test, F-3 Redis-backed rate limiting,
merchant token-deduction admin control, and the settlement-recovery totals
issue. Preserve this list as roadmap history; use the Current Active Phase
summary and EXECUTION_QUEUE.md for present status.

### Prior active phase (007 — Revenue & Settlement Platform)

Bootstrap shipped 2026-07-09: `domains/revenue/` is the single financial
authority — the append-only double-entry settlement ledger derived from
completed source records, platform revenue as a derived fact, reserve
deductions recorded per deposit, merchant bonus funding structurally
restricted to distributable platform revenue. Next within/after this
platform: the Merchant Performance Bonus issuing engine (Cycle Tracker →
Bonus Calculator → Bonus Ledger) with its MerchantBonusPolicy percentage
owned by the Business Policy Platform.

### Prior phase context (006 — Business Policy Platform, core complete)

Goal was: no business constant remains hardcoded in a service when
configuration is appropriate — reserve ratio, deposit split,
withdrawal rules, algorithm parameters, betting limits, KYC policy, risk
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
    `reserveAllocationPercent` (validated to sum to 100), `reserveUsageRules`
    (typed, not Mixed), plus the same approval/scheduling/rollback lifecycle
    fields as `ConfigVersion`. (`merchantCommissionPercent` /
    `commissionFundingSource` were removed 2026-07-08 — see Known Open Items #7.)
  - `depositPolicy.service.js` — sole writer. `createPolicyVersion` (immediate /
    scheduled / approval-gated, mirrors `setConfigField`'s status logic but also
    supersedes the prior ACTIVE version for that currency), `approvePolicyVersion`,
    `rollbackToPolicyVersion` (creates a new version copying old field values
    forward — never mutates or resurrects history), `applyScheduledPolicyChanges`
    (wired into `cronJobs.js` as of 2026-07-08 — 60s interval, alongside
    `applyScheduledConfigChanges`), `getActivePolicy` (the runtime read path),
    `getPolicyHistory` (audit trail).
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
    actually runs in production** (the old alternate `approveDeposit()` in
    `paymentProcessing.service.js` has been removed). It previously had its OWN
    independent hardcoded 90/10, silently
    ignoring the model's computed fields — a real 04-GOVERNANCE.md §2 violation
    ("no second write path to a value with a designated single-writer
    service") that predates this migration. Fixed to consume
    `order.depositAllocation`/`order.reserveAllocation` instead of recomputing.
  - `04-GOVERNANCE.md` §1 updated: new `DepositPolicy` authority added,
    explicitly noted as superseding "Merchant earnings model: buy/sell spread
    only, commissionRate retired" for the platform-funded-commission case —
    not a silent contradiction of that earlier decision.

**Admin UI shipped (2026-07-07, commission fields removed 2026-07-08):**
`admin-panel/src/Pages/BusinessPolicy/DepositPolicy.tsx`
— currency tabs (INR/USDT), current-active-policy view, "Configure Now" empty
state for unconfigured currencies, an example calculator, full version-history
table with approve/reject/rollback actions, and a create-new-version form
(linked deposit%/reserve% inputs, reserve-usage-rule toggles, required
business justification, optional scheduling/approval-gating). New
`'policy'` nav group ("Business Policy Platform") — deliberately separate
from `'payments'`, since future sibling policies belong there too. Verified
with a real `tsc --noEmit` and a real `vite build` (not just eyeballed) —
both confirmed zero new errors introduced (5 pre-existing, unrelated TS
errors in other files, present in the pristine repo too).

**Platform-oriented architecture, formalized 2026-07-07:** going forward,
new work is organized under platforms, not isolated features — Business
Policy, Operations, Revenue & Settlement, Merchant, Funding, Risk,
Sportsbook, Casino, Communication. See ENTERPRISE_DECISIONS.md. This gives
future work (opposite-side betting rules, reserve usage, payout fees, new
payment providers) a natural home without another structural migration.

**Not yet done, explicitly out of scope for this piece:**
- No Merchant Performance Bonus engine exists yet (Merchant Platform /
  Revenue & Settlement Platform-scoped work — see EXECUTION_QUEUE.md and
  ENTERPRISE_DECISIONS.md 2026-07-08).
- The pre-existing `merchant.routes.js` raw-`$inc` wallet writes (§7
  violation) have since been rerouted through `walletAuthority.service.js`
  (`creditDeposit`/`creditReserve`) on the live approval/confirm paths.
- `SUPPORTED_CURRENCIES` includes `'USDT'` but no USDT deposit flow exists
  yet to actually create an order with that currency.
- **Operational note, not a code gap:** no `DepositPolicy` version has been
  created yet in the live database — the runtime fallback (90/10, logged as
  a warning) is what's actually in effect until an admin uses the new UI (or
  the API directly) to create v1 for `INR`. This is expected bootstrap
  behavior, not a bug.

**buyRate/sellRate → 1:1 flattening: DONE (2026-07-08).** Executed in five
slices directly on `main` (per owner instruction, no feature branches):
order-creation math (`rateUsed: 1`, `fiatAmount === tokenAmount`,
`merchantProfit: 0`), public rate surfaces (shapes kept, constant 1/1/0),
user-panel + merchant-panel UI, admin routes + Token Rates page removal,
and finally the `TokenRates` model itself. Historical orders keep their
real stored values; `'TokenRates'` remains in the `ConfigVersion` enum for
historical audit docs only. `migrate-wallet-system.js` deleted per §13.
See ENTERPRISE_DECISIONS.md 2026-07-08 for compatibility choices and the
explicit interim merchant-earnings consequence.

**Next per the roadmap:** Phase 007 (Operations Platform, orchestration-only)
and the Merchant Performance Bonus engine (Merchant Platform: Cycle Tracker →
Bonus Calculator → Bonus Ledger) — see EXECUTION_QUEUE.md for order.
