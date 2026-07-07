# Enterprise Decisions — Decision Log

**Purpose:** a running log of architecture decisions that aren't obvious from
the code alone — the "why," not the "what" (the code + PHASE_STATUS.md cover
the "what"). Newest first. This file didn't exist before 2026-07-07; created
as part of the DepositPolicy migration since decisions made in that session
need a durable home.

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
