# PROJECT HANDOFF — BettingBazaar (Master Context Document)

**Purpose:** the single source of context for any new Claude Code session.
Read this first; it replaces re-explaining the project. Written 2026-07-09.
This document was created as a context handoff — it changes no code.

Companion docs to read after this: `04-GOVERNANCE.md` (binding rules),
`PHASE_STATUS.md`, `EXECUTION_QUEUE.md`, `ENTERPRISE_DECISIONS.md`,
`AUDIT_FINDINGS.md`.

---

## 1. PROJECT OVERVIEW

**What it is:** BettingBazaar — a real-money betting platform built around a
proprietary **two-sided cycle market** (users bet **DELHI vs BOMBAY**; two
cycle types run continuously: **30-minute** and **Full-Day**). It uses a
**P2P merchant-funded token economy**: users deposit INR to a merchant, who
transfers platform tokens to them; users bet tokens; winners are paid; users
sell tokens back for INR via merchants. Future product lines (sportsbook,
casino, games) are architecturally scaffolded.

**Stack:**
- **Backend:** Node.js (ESM, `"type":"module"`) + Express, MongoDB/Mongoose,
  Redis, Socket.IO + SSE. ~269 routes, ~22K LOC.
- **User panel:** React + Vite + TypeScript (repo root `/`).
- **Admin panel:** React + Vite + TS (`admin-panel/`).
- **Merchant panel:** React + Vite + TS (`merchant-panel/`).
- **Deploy:** Railway (single service, auto-deploys from `main`). MongoDB
  Atlas, Redis (Railway plugin), S3-compatible object storage (iDrive e2).

**Long-term goal / product vision:** an **enterprise-grade, internationally
competitive** betting platform (benchmarked against Stake/bet365/Polymarket
on *engineering quality and workflow*, not features), that is:
- **Ready for 1M+ daily active users** (horizontal + vertical scale).
- **Fully admin-configurable** — every business value (percentages, limits,
  rates, providers, rules, content, merchant capabilities) editable from the
  admin panel by a single non-technical operator, each with plain-English
  explanations.
- **Portable** — able to migrate host/domain/database (e.g. Mongo → other)
  without rearchitecture; all config flows through the DB/admin, not hardcode.
- **Financially exact** — double-entry ledger, single-writer wallet
  authorities, idempotent money flows, no token minting.

---

## 2. WHAT WE HAVE ALREADY DONE (chronological)

The project uses numbered "phases," each shipped as small vertical-slice
commits to `main`, with three checkpoint docs updated per slice.

- **Phases 0–005 (pre-session, treated COMPLETE):** repo baseline, capability
  inventory, domain discovery (13 domains), target architecture
  (`backend/domains/` + governance), technology strategy. Governance doc
  `04-GOVERNANCE.md` is the binding ruleset.

- **Phase 006 — Business Policy / token-economy correction:**
  - Removed `merchantCommissionPercent`/`commissionFundingSource` from
    `DepositPolicy` (merchant incentive is cycle-triggered, not deposit-triggered).
  - Wired `applyScheduledPolicyChanges()` + `applyScheduledConfigChanges()`
    into `cronJobs.js`.
  - **Flattened buy/sell rates to fixed 1:1** (1 token = ₹1). Removed the
    `TokenRates` model, its admin endpoints, and the admin Token Rates page.
    All rate surfaces now return constant 1/1/0 (shapes kept for compat).

- **Phase 007 — Revenue & Settlement Platform (the financial authority):**
  `backend/domains/revenue/`. Append-only **double-entry ledger**
  (`AccountingEvent`, integer **paise**, unique idempotency keys, immutability
  middleware), closed **chart of accounts**, sole-writer
  `revenueSettlement.service.js`. Ledger is **derived** by a 60s reconciliation
  worker that anti-joins COMPLETED PaymentOrders + settled Cycles. Admin API:
  `/revenue/summary`, `/revenue/ledger`, `/revenue/bonus-pool/fund`. Verified
  by 34 control-flow tests. (Shipped via PR #1, merged.)

- **Phase 008 — Merchant Platform:** `MERCHANT_FUNDS` ledger account +
  `issueMerchantBonus()` (pool-capped, idempotent); `MerchantBonusPolicy`
  (Business Policy, versioned, disabled by default);
  **`merchantWallet.service.js`** as the sole writer of `Merchant.tokenBalance`
  (rerouted 7 raw `$inc` sites, added `MerchantWalletLedger` + cross-route
  idempotency); **Merchant Performance Bonus Engine** (matched buy→sell cycle
  volume, ledger-derived high-water marks, 10-min cron); merchant
  analytics/leaderboard/funding-stats/wallet-ledger admin API.

- **Phase 009 — Funding Platform:** `fundingAuthority.service.js` = single
  entry for money in/out; `providerRegistry.js` adapter pattern
  (**MANUAL_P2P_INR live**; **USDT_TRC20** + **PAYMENT_GATEWAY** declared,
  inactive); `fundingEvents.js` = first real wiring of `eventBus.service.js`
  (order-completed → nudges ledger reconciler). Deposit/withdrawal creation
  rerouted through the facade.

- **Phase 010 — Risk Platform:** `backend/domains/risk/riskValidation.service.js`
  = single validation authority (positive/numeric, **multiples-of-10**
  default ON, min/max limits, **reserve-split rounding**, opposite-side
  betting restriction, funding velocity limits, payout-fee arithmetic).
  Configurable **withdrawal** payout fee (`SystemConfig.payoutFeePercent`,
  default 0) → posts to `PAYOUT_FEES` ledger account. 25 tests.

- **Phase 011 — Product Platforms:** **Markets Platform** (`git mv` of
  `domains/game` + `domains/betting` → `domains/markets/` — the cycle market
  unified); **Casino Platform** (`git mv` gameProvider model + routes →
  `domains/casino/`); **Shared Trading Models** (`domains/trading/` — canonical
  sides/statuses + settlement-integration contract). Sportsbook/Games/Event/
  Odds = **declared boundary READMEs + feature flags** (no fake code). The
  **four-tier architecture** was accepted (see §6).

- **Phase 012 (IN PROGRESS) — Enterprise Experience:** **Communication
  Platform** (`notify()` engine + channel adapters — IN_APP live, EMAIL/SMS/
  PUSH declared inactive; Audit Feed + Admin Activity Feed APIs; rerouted the
  4 direct `Notification.create` sites); **Operations Platform**
  (orchestration-only `/operations/overview` + `/operations/config-catalog`);
  **Reporting Platform** (financial/settlement/merchant reports + regulatory
  CSV export); **Analytics Platform** trends (growth/business/revenue/risk).

- **AUDIT session (production hardening):**
  - **Resurrected the dead test suite** — vitest config pointed at a
    nonexistent `server/tests/` path, so `npm test` had silently found nothing.
    Now: 51 **unit tests green** (money math, no DB) + **integration tests**
    (real in-memory Mongo) + **GitHub Actions CI**.
  - **Fixed a live production crash** — 3 broken **dynamic `import()`** paths
    (`../models/` → nonexistent `domains/models/`). These crashed every SSE
    `cycle_snapshot` and cycle creation; **this was the root cause of "winner
    not showing in user panel"** (the app gets cycle state incl. winner from
    that snapshot). Added a CI test that resolves every dynamic import.
  - **§7 fix:** reserve balance was credited via raw `$inc` with no ledger
    trail → added `walletAuthority.creditReserve` (idempotent, ledgered).
  - **F-1 token-minting fix:** merchant deposit-confirm credited the user
    *before* best-effort-debiting the merchant (overdraft allowed, errors
    swallowed) → could mint tokens. Reordered to debit-first-hard-fail, then
    credit, with compensating refund.
  - Added missing **User indexes**; wrote `AUDIT_FINDINGS.md`.
  - **ADM-1:** merchant capability admin control (accept types, **INR/USDT**,
    order range) — enforced in `selectBestMerchant`.
  - **ADM-2:** structured Telegram/social config (username/group/channel),
    admin-editable + shown on Support page.
  - **Fixed all 3 frontend builds** — admin-panel (5 tsc errors) and
    merchant-panel (14 tsc errors) now typecheck + build clean; CI builds all
    three panels on every push.

---

## 3. CURRENT REPOSITORY STATE

- **Branch:** `main` (all work merged/pushed). Deploys to Railway.
- **Backend domains** (`backend/domains/`): `analytics`, `casino`, `cms`,
  `communication`, `configuration`, `disputes`, `funding`, `identity`,
  `markets`, `merchant`, `notification`, `operations`, `payment`, `reporting`,
  `revenue`, `risk`, `settlement`, `sportsbook`/`games`/`event`/`odds`
  (declared, README-only), `trading`, `user`, `wallet`.
- **Single-writer authorities (enforced by governance §1):**
  - User balances → `walletAuthority.service.js`
  - Merchant token balance → `merchantWallet.service.js`
  - Settlement ledger → `revenueSettlement.service.js`
  - Money in/out → `fundingAuthority.service.js`
  - Deposit/reserve split policy → `DepositPolicy` (via its service)
  - Configurable numbers/rules → Business Policy (`SystemConfig` + policy docs)
  - Validation/operational rules → `riskValidation.service.js`
- **Build status:** all three frontends **build clean** (tsc 0 errors + vite
  build). Backend: `node --check` clean; 51 unit tests pass; integration tests
  run in CI (not in the restricted sandbox — see §12).
- **CI:** `.github/workflows/ci.yml` — unit tests + integration tests + build
  of all 3 panels on push/PR.
- **Architecture drift:** mostly resolved. Remaining: `domains/settlement/`
  (batch executor) not folded into markets/wallet; a few legacy inline paths;
  product platforms are declared-not-implemented (intentional). No known
  duplicate authorities.

---

## 4. PROGRESS REPORT (honest estimates)

| Area | % | Notes |
|---|---|---|
| Overall | ~45–50% | strong foundation, large frontend + verification gap |
| Backend | ~55–60% | money core/ledger/domains done; settlement fee, USDT, email/SMS, many admin controls, full integration coverage missing |
| Frontend | ~30–35% | all 3 panels build; most Phase 7–12 APIs have **no UI**; UX issues |
| Architecture | ~80% | four-tier taxonomy, single-writer authorities, governance solid |
| Workflow | ~50% | core flows work; winnings fee, winner board, admin-editability gaps |
| Production readiness | ~30% | builds/deploys, but no integration coverage of money flows, in-memory rate limiting, known open money bugs, no external pentest/license |
| Documentation | ~85% | governance + phase docs + findings thorough |

**Complete:** 1:1 token economy, double-entry ledger + reconciler, merchant
wallet authority + bonus engine, funding facade + provider registry, risk
validation authority, platform domain structure, all builds green, CI.

**Partial:** Phase 012 (backend APIs exist, no admin UI), merchant admin
controls (capabilities done; token-deduction control missing), Communication
(IN_APP only), reporting/analytics (API only).

**Remaining:** see §5.

---

## 5. REMAINING WORK (roadmap)

**Phase A — Betting-logic correctness & admin-configurability (IN PROGRESS,
current task):**
- Make the **bet-funding split** (deposit% / reserve% of stake, default 97/3)
  **admin-editable** — currently **hardcoded `0.97`/`0.03` and rounded to
  integers** (a bet of 10 pulls 10/0, not the intended 9.7/0.3).
- Implement the **1% platform fee on winnings settlement** (bet 100 → win 200
  → charge ~2), **admin-editable** — currently **not implemented** (flat 2×
  payout, no fee). Must flow to platform revenue in the ledger.
- Confirm/keep the fallback funding (reserve short→deposit, deposit
  short→winnings — already correct in code).
- Why: these are the core money rules the operator must control; today they
  are hardcoded/missing.

**Phase B — Remaining open money bugs & scale blockers:**
- **F-2:** `settlementService.js` raw `$inc` on locked balances (§7) — reroute
  via wallet authority **with an integration test of settle-under-concurrency**.
- **F-3:** rate limiting is **in-memory** → won't work across horizontally
  scaled instances; move to **Redis store** (Redis already provisioned).
- Merchant **token-deduction** admin control (only top-up/credit exists today).
- Integration test coverage for every money flow (deposit→bet→settle→withdraw,
  bonus issuance) — the prerequisite to trusting money code.

**Phase C — Admin panel UI build-out (the biggest visible gap):**
- Screens for all Phase 7–12 APIs: revenue/ledger, bonus policy, merchant
  platform, operations overview, **config catalog**, reports (with **search/
  filter/date-range**, Excel-style tables), audit feeds.
- **Merchant editor** wired to `/merchants/:id/capabilities` (ADM-1 API).
- **KYC queue with document preview** (S3/CDN image) before approve/reject.
- **Plain-English explanations + examples** on every setting (reserve ratio,
  settlement deduction, daily cap, etc.).
- Winner board fix (**cycle/game-based**, not platform-total).
- Make **every** business variable admin-editable (USDT rate, FAQ, etc.).

**Phase D — User panel UX:** results density (many per screen), cycle
toggle + timer placement, header-hides fix, global sizing (Stake-like density,
easy on the eyes), recover-account on login/signup.

**Phase E — Plugins/integrations (need real credentials):** Email/SMS/Push
channel adapters; USDT/TRON treasury to activate USDT deposits; payment
gateway; a real Telegram bot (if desired).

**Phase F — Production hardening:** external pentest, bug bounty, licensing
(real-money betting is a licensed activity), responsible-gaming/geo controls,
load testing, connection-pool/read-replica tuning.

---

## 6. ORIGINAL VISION & ARCHITECTURE COMPARISON

**Intended workflow (as discussed):**
- Deposit: user pays INR to a merchant → merchant **transfers** platform
  tokens (never mints) → tokens split **90 deposit wallet / 10 reserve wallet**
  (DepositPolicy, admin-editable, versioned).
- Bet: stake drawn **97% deposit / 3% reserve** (admin-editable) with fallback
  (reserve short→deposit, deposit short→winnings).
- Win: gross 2× payout, minus a **1% platform fee** on the settlement
  (admin-editable) → net to winnings wallet; fee → platform revenue.
- Sell/withdraw: only **winningsBalance** eligible, within admin limits →
  merchant pays INR → tokens returned to merchant wallet.
- USDT: admin-editable rate; on deposit converts to platform token, then
  identical downstream logic.
- Merchant bonus: platform-funded, cycle-completion-triggered, from
  distributable revenue — **never** from users.

**Accepted final architecture (four tiers):**
- **Core Enterprise:** Business Policy, Operations, Revenue & Settlement,
  Funding, Merchant, Risk.
- **Product:** Sportsbook, Casino, Games, Markets, Odds, Event.
- **Customer:** Communication, Wallet, Rewards, KYC.
- **Enterprise Services:** Reporting, Analytics, Notification, Treasury,
  Configuration, Audit, Integration.

**Vs. Stake/bet365/Polymarket (engineering only, not features):** the design
matches enterprise standards on **modularity** (bounded domains, single-writer
authorities), **financial consistency** (double-entry, integer minor units,
idempotency, append-only ledger), **governance** (binding ruleset, one source
of truth per value), and **configurability**. It **lags** on **verification
maturity** (integration/load/security testing), **operational tooling** (admin
UI depth), and **compliance** (licensing/KYC-AML/responsible gaming), which are
what actually separate a hobby build from a live operator.

---

## 7. HOW TO THINK DURING FUTURE AUDITS (mindset the operator repeatedly asked for)

- **Think like a real user.** Walk each screen/button/flow as a human would.
- **Trace complete workflows end-to-end:** frontend state → API call → route →
  service → DB write → event/SSE → frontend update. Verify each hop.
- **Root causes, never symptoms.** (E.g. "winner not showing" was not a UI
  bug — it was an SSE snapshot crash from a broken dynamic import.)
- **Verify runtime paths, not just static checks.** `node --check` and static
  imports do NOT catch dynamic `import()` path bugs — those only fail at
  runtime. Prefer real execution/tests.
- **Never assume, never hallucinate. Prove every finding from the repo** (grep,
  read the actual code). Correct yourself when wrong (e.g. FORCE_RESULT *does*
  pay out via the engine tick — verified before nearly introducing a double-pay).
- **Understand the full lifecycle before changing money code.** Money changes
  need a test first; do not change the settlement hot path blind.
- **Don't limit to what's explicitly asked** — search for adjacent issues.
- **Everything must be admin-editable** — no hardcoded business values.
- **Compare against international standards** where it informs a decision.

---

## 8. KNOWN ISSUES (by module; ✅=fixed, ⛔=open)

**Token economy / Betting logic**
- ⛔ Bet-funding split hardcoded `0.97`/`0.03` **and** integer-rounded → gives
  10/0 not 9.7/0.3; must be admin-editable + precision decided. (Phase A)
- ⛔ **1% winnings platform fee not implemented** (flat 2× payout). (Phase A)
- ✅ buy/sell flattened to 1:1; TokenRates removed.

**Wallet**
- ⛔ **F-2:** `settlementService.js` raw `$inc` on locked balances (§7).
- ✅ **F-1:** merchant deposit-confirm token-minting order fixed.
- ✅ reserve credit via `creditReserve` (was raw `$inc`, no ledger).

**Payments / Funding**
- ⛔ USDT deposits not live (declared adapter; needs TRON + admin rate).
- ⛔ Merchant token-**deduction** admin control missing (only top-up).
- ✅ deposit/withdrawal creation via funding facade.

**Merchant**
- ✅ ADM-1 capabilities (accept types, INR/USDT, order range) admin-editable +
  enforced in assignment.

**Admin**
- ⛔ Winner board shows **platform-total net profit**, not cycle/game-based.
- ⛔ FAQ hardcoded (WF-2); no reports UI; no search/filter/date-range.
- ⛔ Settings lack **explanations/examples** (reserve ratio, deductions, cap).
- ⛔ Not every variable admin-editable yet (USDT rate, etc.).
- ✅ admin-panel build fixed (5 tsc errors).

**KYC / Auth**
- ⛔ KYC approve/reject has **no document preview** (WF-3).
- ⛔ Recover-account link missing on login/signup (WF-4); backend model exists.

**API / Runtime**
- ✅ 3 broken dynamic `import()` paths crashing prod (FIXED — redeploy).
- ✅ FORCE_RESULT verified to pay out via engine tick (NOT a bug).

**Frontend / UX**
- ⛔ Components/fonts too big; header hides; results density 3–4/screen; cycle
  toggle + timer placement (UX-1/2/3).
- ✅ merchant-panel build fixed (14 tsc errors).

**Scale / Deployment**
- ⛔ **F-3:** in-memory rate limiting won't scale horizontally (need Redis store).
- ✅ missing User indexes added.
- ⛔ No integration coverage of money flows (harness exists; tests to write).

**Communication**
- ⛔ EMAIL/SMS/PUSH channels declared but inactive; no real Telegram bot (WF-5).
- ✅ ADM-2 structured telegram/social config admin-editable.

**Security**
- ⛔ Live secrets were pasted in chat → **rotate all before launch**.
- ✅ verified good: bcrypt cost 12, IDOR ownership checks, admin auth-gating,
  JWT crashes if secret missing, no secrets committed to repo.

---

## 9. REPOSITORY GOALS ("finished" definition)

"Finished / production-ready" means:
- Every money flow **integration-tested** and proven under concurrency; ledger
  conserves; no minting; idempotent everywhere.
- **Every business value admin-editable** with explanations; a single
  non-technical operator can run the platform.
- **Horizontally scalable** (stateless app tier, Redis-backed limits/cache/
  sessions, indexed hot paths) to 1M+ DAU.
- **Portable** (host/domain/DB swap without rearchitecture).
- All 3 panels polished, dense, fast, consistent.
- Compliance path underway (license, KYC/AML, responsible gaming, pentest).
- Quality standard: enterprise engineering (Stake-grade workflow/architecture).

---

## 10. THINGS WE MUST NEVER BREAK

1. **Financial integrity:** double-entry, conservation to zero, integer paise,
   idempotency keys, append-only ledger (corrections = reversing entries).
2. **Single source of truth / single-writer authorities** (§1 governance) —
   never add a second write path to a value.
3. **Governance §0 pre-edit checklist** — read it before editing any file.
4. **Tokens are transferred, never minted** (merchant debited before user
   credited, atomically or with compensation).
5. **No hardcoded business value** that should be admin-config; **no dead admin
   field** without a real consumer (§2).
6. **Production stability** — verify dynamic imports/runtime paths; don't boot
   the server against the prod DB (it spawns cron/game-engine writers).
7. **Idempotent migrations**; **DB/API/runtime/UI consistency**.
8. **Money code changes require a test first** — never change settlement blind.

---

## 11. IMPORTANT FILES

- `04-GOVERNANCE.md` — binding ruleset; §0 checklist, §1 authorities, §2
  forbidden patterns, §7 wallet, §11 events. **Read before any edit.**
- `PHASE_STATUS.md` — phase table + current active phase.
- `EXECUTION_QUEUE.md` — ordered next tasks + deferred items (recent history).
- `ENTERPRISE_DECISIONS.md` — the "why" behind non-obvious decisions.
- `AUDIT_FINDINGS.md` — the security/workflow audit (F-1 fixed, F-2/F-3 open).
- `ARCHITECTURE.md`, `FUTURE_CAPABILITIES.md` — older context (governance
  supersedes where they disagree).
- Domain `README.md`s (markets, casino, merchant, funding, risk, revenue,
  communication, operations, reporting, trading, sportsbook/games/event/odds).
- `.github/workflows/ci.yml` — CI (tests + 3 panel builds).
- `vitest.config.ts` (unit) + `vitest.integration.config.ts` (DB) +
  `backend/tests/unit/*` + `backend/tests/integration/*`.
- Key services: `revenueSettlement.service.js`, `walletAuthority.service.js`,
  `merchantWallet.service.js`, `fundingAuthority.service.js`,
  `riskValidation.service.js`, `merchantBonus.service.js`,
  `markets/gameEngine.js`, `markets/cycleGenerator.service.js`,
  `markets/bet.routes.js`, `configuration/*Policy*`.

---

## 12. RAILWAY INFORMATION

**Do NOT store secret values in the repo.** Below are the variable *names* and
non-sensitive values only; secret values live in the Railway dashboard and
**must be rotated before launch** (they were exposed in chat during testing).

- **Non-secret / config:**
  - `NODE_ENV=production`
  - `APP_BASE_URL=https://betting-bazaar-production-ready.up.railway.app`
  - `VITE_API_URL=` (same base URL)
  - `VITE_MERCHANT_PANEL_URL=<base>/merchant`
  - `VITE_APP_VERSION=4.0.0`
  - `ALLOWED_ORIGINS=<base URL>`
  - `JWT_EXPIRES_IN=7d`
  - `S3_ENDPOINT=s3.ap-northeast-1.idrivee2.com`, `S3_REGION=ap-northeast-1`,
    `S3_BUCKET_NAME=user-data`, `CDN_URL=<s3 endpoint>/user-data`
  - `MAINTENANCE_MESSAGE="We are currently performing scheduled maintenance…"`
  - `DEFAULT_ADMIN_MOBILE=9999999999`
- **Secrets (names only — values in Railway, ROTATE before launch):**
  `JWT_SECRET`, `SESSION_SECRET`, `CSRF_SECRET`, `ENCRYPTION_KEY`,
  `ORDER_HMAC_SECRET`, `MONGODB_URI` (Atlas, cluster `betting-bazaar`),
  `REDIS_URL` (Railway Redis), `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `DEFAULT_ADMIN_PASSWORD` (was a weak default — change it).
- **Runtime:** app listens on **port 8080**; start = `node server.js`; build
  installs + builds all three panels. Auto-deploys from `main`.
- **Production observations (from Railway logs):** app boots (Game Engine,
  Cycle Generator, Mongo, Redis all connect). **Was crashing repeatedly** on
  `Cannot find module '/app/backend/domains/models/index.js'` from
  `cycleGenerator.service.js` — **fixed** (broken dynamic import); redeploy to
  clear. Cycles auto-create every 30 min; ledger reconcile logs
  "Recorded N accounting event(s)".

---

## 13. CURRENT DIRECTION (assessment)

**Right direction?** Yes on architecture — the domain/single-writer/ledger/
governance foundation is sound and is what will make the platform scale and
stay financially correct. The four-tier taxonomy is a good organizing model.

**Risks / debt remaining:**
- **Verification debt is the #1 risk.** Much was verified only by
  static/pure-function checks; money flows lack integration coverage. Build the
  tests before trusting/extending money code.
- **Scaffolding vs. reality:** several "platforms" are declared, not
  implemented (fine, but don't mistake them for done).
- **Frontend is the largest unbuilt surface** — most backend APIs have no UI.
- **Scale blockers** (in-memory rate limiting) and **compliance** (licensing)
  are unaddressed.

**Avoid going forward:** adding more platforms/scaffolding before proving and
building what exists; changing settlement/money code without tests; committing
secrets; booting the server against the prod DB.

**Focus next:** Phase A (betting-logic correctness + admin-configurability),
then Phase B (F-2/F-3 + integration tests), then Phase C (admin UI).

---

## 14. PERMANENT INSTRUCTIONS FOR FUTURE CLAUDE CODE SESSIONS

Before any change:
1. **Read `04-GOVERNANCE.md` §0 checklist** and the section governing your change.
2. **Understand the architecture first** (this doc + PHASE_STATUS + the relevant
   domain README). Never randomly edit files.
3. **Trace dependencies and runtime impact** — who imports/consumes this? What
   fires at runtime? Check dynamic imports and event/SSE hops, not just static.
4. **Validate against governance** (single-writer authorities, no dead admin
   fields, no hardcoded business values) and **against production** behavior.
5. **Preserve financial correctness** (double-entry, idempotency, integer
   paise, no minting) and **workflow correctness** (full lifecycle).
6. **Prefer root-cause fixes over patches.** Prove findings from the repo.
7. **Money code:** write/extend a test first (unit for pure math, integration
   in CI for DB flows). Never change the settlement hot path blind.
8. **Verify before claiming done:** `node --check`, unit tests, and the
   relevant build. State honestly what was and wasn't verified.
9. **Do not commit secrets; do not connect the sandbox to the prod DB.**
10. **Update the three checkpoint docs** (PHASE_STATUS / EXECUTION_QUEUE /
    ENTERPRISE_DECISIONS) after each slice, and commit small vertical slices.

---

## 15. QUICK-START FOR THE NEXT SESSION

The immediate in-progress task (Phase A): make the **bet-funding split**
(deposit%/reserve% of stake) **admin-editable** (replace hardcoded `0.97`/`0.03`
in `backend/domains/markets/bet.routes.js`; decide integer vs fractional
precision), and **implement the admin-editable 1% winnings platform fee** in
the settlement engine (`markets/gameEngine.js`), routing the fee to platform
revenue in the ledger. Centralize both as pure functions in the Risk Platform
with unit tests, expose the config via `SystemConfig` + admin GET/PUT, and add
integration tests. Then Phase B (F-2/F-3), then the admin UI (Phase C).
