# Phase X — Enterprise Validation & Hidden Workflow Audit

**Date:** 2026-07-10. **Method:** static analysis of the actual code, every
finding cited to `file:line`. Severity: 🔴 critical · 🟠 high · 🟡 medium ·
🟢 verified-good. Each finding is marked **CONFIRMED** (proven from the repo)
or **VERIFY** (a gap in coverage, not a proven defect).

This audit deliberately looked for ARCHITECTURAL gaps — categories that hide
defects — rather than re-listing known bugs. It was prompted by a blind-spot
checklist: distributed-transaction boundaries, idempotency coverage,
authorization consistency, configuration bypasses, cross-panel contract
drift, state-machine completeness, background-job resilience, observability,
data lifecycle, concurrency.

**UPDATE 2026-07-10 (same session):** X-1/X-2/X-3, X-4, X-5, X-9 were FIXED after this audit (reserve funding on both deposit paths + approve reroute off raw $inc [Known Open #6 closed], cron leader election, configurable cycle duration, assignment-race test). X-6 (observability), X-7 (data lifecycle), X-8 (authz matrix) remain open.

CI at audit time: **green — 72 unit + 30 integration tests** (commit ef1c0ac).

---

## 🔴 X-1 CONFIRMED — Two divergent deposit-completion endpoints (the reserve wallet may never be funded)

There are **two** merchant deposit-completion routes with **different money
semantics for the same logical action**:

- `POST /api/merchant/confirm/:id` (`merchant.routes.js:436`, credit at `:494`)
  credits **the full `tokenAmount` to `depositBalance`** via `creditDeposit` —
  **no deposit/reserve split at all**.
- `POST /api/merchant/orders/:id/approve` (`merchant.routes.js:1197`, credit at
  `:1261-1274`) credits **`order.depositAllocation` to deposit and
  `order.reserveAllocation` to reserve** — the DepositPolicy split.

The merchant panel exposes **both** (`merchant-panel/src/services/api.ts:246`
calls `/orders/:id/approve`; `merchant-panel/src/constants.ts:34` defines
`CONFIRM → /api/merchant/confirm/:id`).

**CONFIRMED LIVE PATH (2026-07-10):** the merchant panel's deposit UI
(`merchant-panel/components/OrderCard.tsx:166` "PAID (DEPOSIT) — must
confirm", `pages/OrderManagement.tsx:526`) calls **`CONFIRM → /confirm/:id`**
(`services/api.ts:211`). `approveOrder` (the split path) has **no caller in
the panel**. So the live deposit path is the **no-split** one — the reserve
wallet is almost certainly **not being funded in production today.**

**Impact:** with the live path being `/confirm/:id`, the reserve
wallet is **never funded** — `reserveBalance` stays 0 for real deposits. That
silently disables the entire reserve-funded economy the platform is built on:
`DepositPolicy`, and the Phase A `betReservePercent` split, become dead
mechanisms (every bet's "reserve share" would just shortfall-shift onto
deposit). This is the single highest-value finding: a core money workflow may
not be running at all, and nothing tests which path is canonical.

**Fix (needs a product decision):** pick ONE canonical deposit-completion
path, make the other delegate to it (or remove it), and add an integration
test asserting a completed deposit funds reserve per the active DepositPolicy.

---

## 🔴 X-2 CONFIRMED — Ledger and wallet disagree about reserve on the confirm path (accounting integrity)

The R&S reconciler derives ledger postings from the **order's** allocation
fields: `buildDepositPostings` reads `order.depositAllocation` /
`order.reserveAllocation` (`revenueSettlement.service.js:64-82`), which the
`paymentOrder` pre-save hook always sets from DepositPolicy. But on the
`/confirm/:id` path (X-1) the **wallet** was credited full-to-deposit,
reserve 0.

**Impact:** the append-only ledger reports `PLATFORM_RESERVE` credited by the
reserve allocation while the user's actual `reserveBalance` is 0 — the
accounting view and the wallet authority **disagree**, on the exact split the
ledger is supposed to prove. `getTrialBalance().integrityOk` stays true (the
ledger self-balances), so this divergence is invisible to the integrity
check — it only shows up as "reserve tokens that exist in the books but not in
any wallet." Resolving X-1 resolves this.

---

## 🟠 X-3 CONFIRMED — Live deposit-approve credits the user via raw `$inc` (§7 + idempotency defense-in-depth)

`POST /orders/:id/approve` credits the user with a raw
`User.findOneAndUpdate({$inc:{depositBalance, reserveBalance}})`
(`merchant.routes.js:1265-1274`) plus a hand-written `WalletLedger.insertMany`
— **bypassing `walletAuthority.creditDeposit/creditReserve`** (the §7 sole
user-balance writer). Two consequences:

1. **No idempotency key on the user credit.** The only thing preventing a
   double-credit is the `PAID → COMPLETED` status guard (`:1210-1214`). There
   is no `dep_complete_<orderId>` ledger-key backstop as there is on every
   other credit path, so this path is **not** mutually idempotent with
   `/confirm/:id` — cross-path safety rests entirely on the status transition.
2. **Silent non-atomic degradation.** `safeSession()` returns `null` on
   standalone Mongo (`merchant.routes.js:1433-1441`) and the route then runs
   **without a transaction** (`withSession(null) → {}`). A crash between the
   merchant debit and the user credit leaves the order `COMPLETED` but the
   user un-credited, and the `409 "already approved"` guard (`:1220`) makes it
   **unrecoverable** — an orphaned workflow. (Production Atlas is a replica
   set so transactions do work there; the risk is the coded-in degradation +
   the missing key.)

This is Known Open Item #6 (previously framed only as a §7 tidiness issue);
the **correctness/idempotency consequence above is the new insight.**

**Fix:** route the credit through `creditDeposit(userId, depositAllocation,
orderId, session)` + `creditReserve(userId, reserveAllocation, orderId,
session)` — idempotent on canonical keys, §7-compliant, atomic under the
session. Add an integration test: double-approve credits once; approve funds
reserve. (Money hot path — test first, per governance §10.8.)

---

## 🟠 X-4 CONFIRMED — Background jobs have no leader election (not multi-instance safe)

`startup/cronJobs.js` registers every worker with a bare `setInterval`
(`:14, :22, :43, :56, :84, :108`) — leaderboard rebuild, referral-commission
credit, order-expiry, scheduled-policy apply, ledger reconciler, bonus engine.
There is **no distributed lock / leader election**. On more than one backend
replica, **every replica runs every job concurrently.**

**Impact:** today it is safe ONLY because each job's writes are individually
idempotent (reconciler anti-join, commission `comm_<id>` txId, expiry
`expiry_refund_<id>` txId, bonus-engine deterministic keys). It is
load-multiplying (N× the DB work) and one non-idempotent job away from
double-execution. This is the same root cause as the already-queued SSE
fan-out item: **the app assumes a single instance.** A `>1 instance`
deployment needs a leader-election wrapper (a Mongo TTL-lock or Redis lock)
around the interval bodies — the Redis client already exists.

---

## 🟡 X-5 CONFIRMED — Cycle duration is hardcoded, not admin-configurable

Cycle length is `30 * 60 * 1000` hardcoded in
`cycleGenerator.service.js:424`. The betting-window duration is a core
business lever, and the platform's stated goal is "every business value
admin-editable." It is neither in `SystemConfig` nor the config catalog.

**Fix:** move 30-min / full-day durations into `SystemConfig` (Business
Policy) and read them in the generator; add to the operations config catalog.
Runtime-sensitive (the generator loop + `GAME_CORE.ts` display mirror both
consume it) — scope as its own slice.

---

## 🟡 X-6 OPEN — Observability: no correlation IDs, structured logging, or metrics

Logging is ad-hoc `console.*` throughout; there is no request/correlation ID
threaded across the route → service → DB → event/SSE hops, no structured log
format, and no metrics/alerting surface. `EnhancedAuditLog` covers admin
financial actions well, but there is no request-level tracing to reconstruct a
single deposit's journey across the async boundaries. Recommend: a request-ID
middleware, a thin structured logger, and (owner-side) log-based alerts on the
ledger `integrityOk:false` signal and settlement errors (noted in
PRODUCTION_READINESS.md §A5).

---

## 🟡 X-7 OPEN — Data lifecycle: no retention / archival / soft-delete strategy

Unbounded, ever-growing collections with no archival plan: `AccountingEvent`
(immutable by design — correct, but needs an archival/partitioning plan for
scale), `WalletLedger`, `Bet`, `Transaction`, `PaymentOrder`,
`EnhancedAuditLog`, `FrontendErrorReport`. No soft-delete convention (some
flows hard-delete, some flip status). At 1M DAU these dominate DB size and
index memory. Recommend: a documented retention policy per collection
(archive-to-cold vs delete vs keep-forever-for-audit) and a cleanup worker for
genuinely transient data.

---

## 🟡 X-8 VERIFY — Authorization matrix not systematically proven

Spot-checks show auth is applied **per-route** inside each sub-router
(`routes/admin/index.js` mounts sub-routers with `router.use('/', …)`; the
individual routes carry `authenticate + isAdmin/isAdminOrSubAdmin`). A crude
"routes without auth" scan produced false positives and is **not** evidence of
a hole. What's missing is a **complete endpoint × role × ownership matrix**
verifying every Admin / Sub-admin / Queue-manager / Merchant / User endpoint
enforces both the correct role AND resource-ownership (the approve path does
check `order.merchantId === req.merchantId` at `:1225` — good; the question is
whether *every* mutating endpoint does). Recommend building that matrix as a
checked table. **No authz hole is asserted here.**

---

## 🟡 X-9 VERIFY — Merchant-assignment concurrency untested

Settlement concurrency is now proven (`settlementConcurrency.integration.
test.js`). The analogous race — two merchants accepting/approving the same
order simultaneously — is guarded in code by the atomic `PAID → …` status
`findOneAndUpdate` (`:1210`, and the queue-assignment `findOneAndUpdate`), but
there is **no test** proving the loser is rejected cleanly. Recommend an
integration test mirroring the settlement one.

---

## 🟢 Verified GOOD during this audit

- Raw balance `$inc` is confined to the three sanctioned wallet authorities
  (`walletAuthority` / `wallet.service` / `merchantWallet`) — grep-clean
  everywhere else. The X-3 case is the one live exception, inside the
  merchant approve route.
- Withdrawal lock lifecycle is idempotent and now releases locks on reject
  (fixed this session).
- Merchant-confirm F-1 (token minting) ordering is correct: debit-first
  hard-fail, then credit, with compensating refund (`:483-504`).
- Order expiry refunds are idempotent (`expiry_refund_<id>`).
- Reconciler is idempotent by anti-join; ledger is append-only + integer
  paise + conservation-checked in CI.

---

## Recommended action order

1. **Decide the canonical deposit path (X-1/X-2)** — highest value; determines
   whether the reserve economy runs at all. Then align/remove the other and
   test it.
2. **X-3** — reroute the approve credit through the wallet authority (idempotent
   + §7 + atomic); test double-approve + reserve funding. Closes Known Open #6.
3. **X-4 leader election** — before any `>1 instance` deploy (with the SSE
   bridge).
4. X-5 (cycle duration config), X-9 (assignment-race test) — self-contained
   slices.
5. X-6/X-7 (observability, data lifecycle) — larger, mostly owner-prioritized.
