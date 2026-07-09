# Enterprise Decisions — Decision Log

**Purpose:** a running log of architecture decisions that aren't obvious from
the code alone — the "why," not the "what" (the code + PHASE_STATUS.md cover
the "what"). Newest first. This file didn't exist before 2026-07-07; created
as part of the DepositPolicy migration since decisions made in that session
need a durable home.

---

## 2026-07-09 — Phase 007 = Revenue & Settlement Platform bootstrap (renumbered)

**Decision (owner directive, 2026-07-09):** Phase 007 is the Revenue &
Settlement Platform bootstrap, built as the single financial authority. The
previous roadmap's 007 (Operations Platform) is NOT cancelled — it remains
orchestration-only, owns no data, and slots after this. Phase 008 (Financial
Core) is partially absorbed: this bootstrap delivers exactly the ledger
foundation 008 called for (double-entry, append-only, idempotency keys,
integer minor units).

**What the platform owns (and nothing else does):** completed bets, completed
payouts, platform revenue, the settlement ledger, reserve deductions, payout
fees, accounting events, merchant bonus funding.

**Boundary decisions:**
- `walletAuthority.service.js` remains the sole wallet-balance writer (§7).
  The R&S ledger is the ACCOUNTING view — it never mutates balances.
- Business Policy Platform remains the only authority for configurable
  percentages/rules. The bonus-funding function takes an explicit amount;
  the future MerchantBonusPolicy (a Business Policy sibling) will automate
  the percentage, and this platform will READ it.
- Merchant bonuses: platform-funded only, issued after completed buy→sell
  cycles from distributable platform revenue, never calculated from
  buyRate/sellRate (which no longer exist), never deducted from users. The
  ledger structurally enforces the funding rule: the only path into
  MERCHANT_BONUS_POOL is a debit of PLATFORM_REVENUE, and funding is
  rejected beyond the distributable balance.

**Ledger design (standard fintech practice, researched 2026-07-09 —
fintechly.com ledger-system-design, sdk.finance double-entry-ledger,
finlego.com real-time ledger design):**
- Append-only journal entries (`AccountingEvent`); mutation/deletion attempts
  throw via model middleware. Corrections are new reversing ADJUSTMENT
  entries, never edits.
- Each entry: signed integer postings in paise summing to exactly zero,
  validated in the service AND as a schema invariant.
- Globally unique `idempotencyKey` per entry; duplicate recording is a
  silent no-op (service check + unique index as belt-and-braces).
- Balances are ALWAYS derived by summing postings — no stored balance field
  that could drift. Distributable revenue = derived PLATFORM_REVENUE
  balance; bonus funding debits it, so "already funded" needs no separate
  bookkeeping.
- Closed chart of accounts (EXTERNAL_FIAT, USER_FUNDS, PLATFORM_RESERVE,
  PLATFORM_REVENUE, PAYOUT_FEES, MERCHANT_BONUS_POOL) with normal-balance
  metadata; ad-hoc account strings are rejected.

**Producer model — the ledger is DERIVED, not inline:** completion code
paths (5 different places set PaymentOrder COMPLETED; gameEngine settles
cycles) are left untouched. A reconciliation worker anti-joins completed
source records against existing entries and records what's missing,
idempotently. Why: one writer instead of five sprinkled recorders, no risk
added to live money flows, self-healing after failures, and free historical
backfill. Trade-off: entries lag up to ~60s and the anti-join scans grow
with history — both acceptable now, checkpoint optimization flagged in
EXECUTION_QUEUE.md.

**Historical-rate residuals:** pre-1:1 orders (fiat ≠ tokens) balance via a
PLATFORM_REVENUE residual leg — the old buy/sell spread lands in revenue,
which is historically accurate. Verified by 34-assertion control-flow tests
against the real posting builders (float-drift kill, profit/loss/zero
cycles, legacy allocation-less orders, lifecycle conservation to zero).

---

## 2026-07-08 — buyRate/sellRate fully flattened to fixed 1:1; TokenRates removed

**Decision:** token conversion is now a fixed 1:1 constant (1 BB token = ₹1)
across the entire stack. The `TokenRates` model, its admin endpoints
(GET/PUT `/api/admin/token-rates`), the admin-panel Token Rates page, and
all rate reads in order creation, public config endpoints, and all three
frontends are gone. New orders carry `rateUsed: 1`, `fiatAmount ===
tokenAmount`, and `merchantProfit: 0`.

**Sequencing:** executed in five slices, each independently green:
(1) order-creation conversion math, (2) public rate surfaces flattened to
constants, (3) user-panel + merchant-panel UI, (4) admin routes + admin
page removal, (5) the model itself. This honored the already-established
dependency order — flattening began only after the Business Policy
foundation (DepositPolicy) shipped 2026-07-07.

**Compatibility choices, made deliberately:**
- Public rate endpoints (`/api/payments/rates`, `/api/v1/tokens/rate`,
  `/api/v1/token/rates`) and the `system_config` payload keep their
  response shapes but return constant 1/1/0 — old clients keep working;
  their math degrades to identity.
- Historical `PaymentOrder` documents keep their real `rateUsed`/
  `merchantProfit` values; only new orders are 1:1. The profit-engine
  admin report still reads per-order stored `fiatAmount`, so historical
  revenue figures are unaffected.
- `'TokenRates'` stays in the `ConfigVersion.modelName` enum so historical
  config-version audit documents stay valid, but it was removed from
  `MODEL_BY_KEY` in `configVersioning.service.js`, so no new TokenRates
  version can ever be written.
- The old `tokenrates` Mongo collection is left in place (nothing reads or
  writes it) — dropping it is a DB operation, not a code change.

**Merchant earnings consequence (explicit, not accidental):** with the
spread gone and `DepositPolicy.merchantCommissionPercent` removed (entry
below), merchants currently earn nothing per order. This is the accepted
interim state per the established dependency chain: the Merchant
Performance Bonus engine (cycle-completion-triggered, platform-funded) is
the next major Merchant Platform work item — see EXECUTION_QUEUE.md.

**Also deleted:** `backend/scripts/migrate-wallet-system.js` — marked
APPLIED since before this migration; §13 dead-artifact policy says applied
migrations are deleted, and it imported the now-removed model, so keeping
it would have left knowingly broken code.

---

## 2026-07-08 — Correction: merchant incentive removed from DepositPolicy;
## "Merchant Performance Bonus" is cycle-completion-triggered, not deposit-triggered

**Decision:** `DepositPolicy.merchantCommissionPercent` and
`commissionFundingSource` — added 2026-07-07 — have been removed entirely
from the schema, service, admin route, `paymentOrder.model.js`'s
`depositPolicySnapshot`, and the admin-panel UI. `DepositPolicy` now governs
**only** the deposit/reserve wallet split and reserve usage rules for a
single incoming deposit.

The replacement concept — not yet built, tracked in EXECUTION_QUEUE.md as
the Merchant Performance Bonus engine — is:
- Triggered by a **completed buy+sell cycle** (a merchant fulfilling both
  sides of a cycle), not by deposit approval.
- A **% of completed cycle volume** (`merchantBonusPercent`), configured on
  a future Merchant/Business Policy, not on `DepositPolicy`.
- A **platform-funded operating expense** — paid from platform revenue,
  **never** deducted from user balances, deposits, or withdrawals. This
  hard rule carries forward unchanged from the 2026-07-07
  `commissionFundingSource: 'PLATFORM'` decision below; only its home and
  name changed.
- Named **"Merchant Performance Bonus"**, not "commission" — deliberately
  distinct terminology from the retired `Merchant.commissionRate` (buy/sell
  spread era) and from yesterday's `merchantCommissionPercent`, so future
  sessions don't conflate three different mechanisms that have shared a
  name at different points in this repo's history.

**Why this is a correction, not just an addition:** `DepositPolicy` is
whole-document versioned specifically because its fields describe "what
happens to one incoming deposit" as a single coherent decision (see the
2026-07-07 entry below). Merchant bonus pay does not happen at deposit time
— it happens when a merchant completes a full buy+sell cycle, a distinct
event with its own timing, its own volume calculation, and no natural
version-coupling to the deposit/reserve split. Modeling it on `DepositPolicy`
made "what version was active" ambiguous for a value that was never actually
resolved at that trigger point. Compounding this, `merchantCommissionPercent`
was already dead: no code anywhere read it to pay a merchant (confirmed in
the 2026-07-07 "Merchant-commission payout is explicitly deferred" entry
below) — so removing it deletes only unused surface area, not working
behavior.

**Safe to remove outright (not deprecate):** no `DepositPolicy` document has
ever been created in the live database (bootstrap fallback state, unchanged
since 2026-07-07 — see PHASE_STATUS.md). There is no data migration, no
in-flight order referencing the removed snapshot fields, and no consumer
code to update elsewhere.

**04-GOVERNANCE.md §1 updated to match:** the `DepositPolicy` authority line
now covers only deposit/reserve split, reserve usage rules; the "Merchant
earnings model" line's note about `DepositPolicy`-driven commission is
superseded by this entry — the platform-funded, never-user-deducted rule
itself survives, but its owner is now the not-yet-built Merchant Performance
Bonus mechanism, not `DepositPolicy`.

**Also done in this pass:** `applyScheduledPolicyChanges()`
(`depositPolicy.service.js`) and `applyScheduledConfigChanges()`
(`configVersioning.service.js`) — both written 2026-07-07 but never called
from anywhere — are now wired into `cronJobs.js` on a 60-second interval,
matching the existing order-expiry-worker pattern (dynamic `import()`,
per-item try/catch so one bad version can't crash the interval or block the
rest of the batch).

---

## 2026-07-07 — Platform-oriented architecture (formalized, not new)

**Decision:** future work is organized under named platforms rather than
isolated features:

- **Business Policy Platform** — versioned business rules (DepositPolicy
  today; Withdrawal/Risk/Merchant/Settlement policies to follow).
- **Operations Platform** — orchestration/admin tooling that reads and acts
  on domains, owns no business data itself.
- **Revenue & Settlement Platform** — ledger, merchant payouts, commission
  settlement, financial reconciliation.
- **Merchant Platform** — merchant lifecycle, pool assignment, scoring.
- **Funding Platform** — INR, USDT, and future payment/funding providers as
  interchangeable adapters behind one interface.
- **Risk Platform** — thresholds, fraud signals, limits.
- **Sportsbook Platform** / **Casino Platform** — game/bet-type-specific logic.
- **Communication Platform** — notifications across channels/providers.

**Why:** this isn't a new direction — FUTURE_CAPABILITIES.md already used
"Platform" language for several of these. What changed 2026-07-07 is treating
it as the organizing principle for where NEW code goes, starting now, rather
than a future aspiration. Concretely: `DepositPolicy` went into a fresh
`Pages/BusinessPolicy/` frontend folder (not `Pages/Finance/`, where
`TokenRates`/`ProfitLoss`/`UTRManager` already live as a grab-bag of
finance-adjacent-but-not-actually-related concerns), and got its own admin
nav group (`'policy'` → "Business Policy Platform") instead of being folded
into the existing `'payments'` group. Every future policy, payout mechanism,
funding provider, or risk rule has an obvious home decided in advance,
instead of prompting "where does this go?" — and therefore another
structural migration — each time.

**Scope of this decision today:** naming and folder/nav placement for new
work. It does NOT mean existing code (e.g. `TokenRates` staying in
`Pages/Finance/`, or `merchant.routes.js` staying where it is) gets moved
retroactively — that would be exactly the "expand scope into an unrelated
migration" pattern 04-GOVERNANCE.md warns against. Existing code moves to
its platform home opportunistically, when it's already being touched for
another reason (as `merchant.routes.js`'s hardcoded-split fix was, in this
same migration) — not as a dedicated reshuffle.

---

## 2026-07-07 — DepositPolicy: whole-document versioning, not field-level

**Decision:** Deposit-allocation %, reserve-allocation %, merchant-commission
%, commission funding source, and reserve-usage rules are versioned together
as ONE document per version (`DepositPolicy`), not as independent fields
through the existing `configVersioning.service.js` (which versions individual
fields on a flat `key:'main'` document — correct for `SystemConfig`/`TokenRates`,
wrong here).

**Why:** these values are not independent — they describe one coherent
business decision ("what happens to an incoming deposit"). Field-level
versioning would let deposit%+reserve% and commission% drift out of sync
mid-change: an admin could update reserve% in one request and commission% in
a second request a minute later, with no single version ID describing "the
policy in effect" during that gap. Whole-document versioning closes the gap —
every version is a complete, internally consistent snapshot, and exactly one
version is ACTIVE per currency at any moment.

**Rejected alternative:** scattering `reserveRatio`, `merchantCommissionRate`,
etc. as four-plus separate `SystemConfig` fields, each versioned independently
via the existing service. This was the original, narrower task scope; changed
mid-session once the coupling above was identified as the real requirement.

---

## 2026-07-07 — Naming: `DepositPolicy`, not "Deposit Allocation Policy"

**Decision:** the new model/service/routes are named `DepositPolicy`, not
"Deposit Allocation Policy" or "Financial Allocation Policy."

**Why:** FUTURE_CAPABILITIES.md's Business Policy Platform list already
anticipates siblings — Withdrawal, Settlement, Risk, Merchant policies — one
policy per money-moving **event type**, not one policy per field group.
"Allocation" describes only the wallet-split fields and undersells the two
other things this document owns (commission funding source, reserve usage
rules). "DepositPolicy" matches the naming pattern its own future siblings
will use (`WithdrawalPolicy`, `SettlementPolicy`, ...).

---

## 2026-07-07 — `commissionFundingSource` is validated, not just defaulted
**[SUPERSEDED 2026-07-08 — see entry at top of file. The field itself was
removed from `DepositPolicy`; the "platform-funded, never user-deducted"
rule survives, now owned by the not-yet-built Merchant Performance Bonus
mechanism. Kept below for historical context on why the enum-not-boolean
modeling choice was made.]**

**Decision:** `DepositPolicy.commissionFundingSource` is a schema enum of one
value (`'PLATFORM'`) today, and `depositPolicy.service.js`'s
`validatePolicyFields()` explicitly rejects any other value with a business-
rule error message — rather than merely defaulting to `'PLATFORM'` and
allowing something else through.

**Why:** "merchant commission is never deducted from user balances" is a hard
business rule (2026-07 direction), not a preference that happens to be
PLATFORM today. Modeling it as an enum (not a boolean) leaves room for a
genuinely new funding source later without a field rename, while the service-
layer rejection means the rule can't be silently bypassed via a future API
change that widens the enum without updating the validator to match — the two
have to be changed together, on purpose.

**Supersedes:** 04-GOVERNANCE.md's prior §1 entry "Merchant earnings model:
buy/sell spread only, `Merchant.commissionRate` retired." That decision
covered a *different* mechanism (a per-merchant commission rate field,
removed as part of the buyRate/sellRate spread model). This decision does not
revive that field — `DepositPolicy.merchantCommissionPercent` is a new,
platform-funded mechanism, tracked as its own line in §1 with an explicit
cross-reference so the two aren't read as contradicting each other by
accident.

---

## 2026-07-07 — Merchant-commission *payout* is explicitly deferred
**[SUPERSEDED 2026-07-08 — the modeled `merchantCommissionPercent`/
`commissionFundingSource` fields described here were removed, not just left
unpaid; the deferred payout-engine work continues under the renamed
Merchant Performance Bonus concept — see entry at top of file and
EXECUTION_QUEUE.md.]**

**Decision:** this migration models, validates, versions, and exposes
`merchantCommissionPercent`/`commissionFundingSource` for admin editing — but
does not build the engine that actually pays a merchant a platform-funded
commission.

**Why:** no such engine exists in the repository today (there is no
`MerchantProfitEngine`/commission-payout code as of this snapshot — merchants
currently earn only via the buy/sell spread, per the now-annotated §1 entry
above). Building a real payout mechanism means new `Transaction` types,
ledger entries routed through `walletAuthority.service.js`, and a timing
decision (per-order vs. batched settlement) — a financial-flow design
decision in its own right, not something to bundle silently into a
policy-modeling task. Flagged in PHASE_STATUS.md as an open next-step choice
rather than decided unilaterally.

---

## 2026-07-07 — Fixed the live 90/10 hardcode in `merchant.routes.js`, not just the model

**Decision:** in addition to the new `DepositPolicy`-driven computation in
`paymentOrder.model.js`'s pre-save hook, the independently hardcoded 90/10 in
`merchant.routes.js` POST `/orders/:id/approve` was also removed, in favor of
consuming the order's already-computed `depositAllocation`/`reserveAllocation`.

**Why:** tracing the actual call graph showed `merchant.routes.js`'s inline
route handler — not `paymentProcessing.service.js`'s `approveDeposit()` — is
the live, called code path. `approveDeposit()` is never imported or invoked
anywhere; it's dead code that happened to already do the "right" thing
(consume the stored fields). Fixing only the model's pre-save hook would have
left the actual production behavior unchanged, since the live route
recomputed its own ratio and ignored the stored fields entirely. This was a
pre-existing 04-GOVERNANCE.md §2 violation (a second write path to the same
value) that predates this migration; it was in scope to fix because it's the
same runtime-consumption endpoint DepositPolicy needed to reach to have any
real effect.

**Not fixed (separate decision):** `merchant.routes.js`'s wallet-balance
writes still use raw `$inc` rather than `walletAuthority.service.js` — a
pre-existing §7 violation, left alone because rerouting it is a larger,
separate change (see PHASE_STATUS.md Known Open Items #6).
