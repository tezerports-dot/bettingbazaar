# Handoff — next session

Paste the block at the bottom as your opening message. Everything above it is
context you may want to read first, but the prompt is self-contained.

---

## Where things stand

**6 of 11 money domains** are fully built, routed, reconciled and reversible:
wallet, merchant wallet, merchant settlement, admin issuance, sports settlement,
bonuses & commissions.

**0 of 11 are certified**, for two independent reasons:

1. **Orders is not routed.** The authority resolver refuses Postgres for any
   path whose dependencies are still on Mongo, and Orders sits under Bets,
   Settlements and Ledger. It is the gate for the whole cutover.
2. **`infrastructureTested` is false everywhere.** That needs a staging
   environment and six drills (`docs/GO_LIVE_RUNBOOK.md` §2.2). It is not a
   coding task and no amount of code will clear it.

**Launching does not depend on either.** Every money path defaults to MongoDB
and works. `GO_LIVE_RUNBOOK.md` Part 1 is the launch checklist.

## What was done in the last session

- Sports Settlement and Bonuses: mirror, reconcile, reverse mirror, routing —
  flipped on CI evidence
- Orders **stage 1 seam** built: `domains/payment/orderLifecycle.service.js`
- **1 of 26** order status call sites converted
- `docs/ORDERS_ROUTING_DESIGN.md` — the three-stage plan, written after finding
  that Orders has no choke point
- nanoid advisory fixed across all four lockfiles; 3 Dependabot PRs merged

## The live bug worth knowing about

Mongo's order path had **no state machine**. `PaymentOrder.status` is a string
that 26 sites assign directly, mostly `order.status = 'X'; order.save()` — a
read-modify-write on a stale read. A cancelled order can be completed; a failed
one can be paid. What prevents it today is the order in which route handlers
happen to run, and ordering is not an invariant.

`orderLifecycle.service.js` is the fix. Converting the remaining 25 sites is
what makes it real.

## Why converting sites is safe to do incrementally

This is the distinction that matters, and it is the opposite of the rule for
routing:

- **Guarding (stage 1) is monotonic.** Every converted site is still writing to
  the same store. A partially guarded path is strictly safer than an unguarded
  one.
- **Routing (stage 2) is not.** A partial conversion leaves some transitions
  authoritative in Postgres and others in Mongo, and no reconciliation can tell
  that apart from the two stores genuinely disagreeing.

So stage 1 can be split across sessions. Stage 2 cannot.

---

# THE PROMPT — paste this

```
Continue the PostgreSQL migration on branch claude/enterprise-golive-audit-w52sz7.

Read these first, in order:
  docs/ORDERS_ROUTING_DESIGN.md          the three-stage plan and why
  backend/domains/payment/orderLifecycle.service.js   the seam, already built
  backend/tests/unit/orderLifecycle.test.js           its 13 tests
  backend/postgres/moneyAuthority.js     the registry — the source of truth

Do these in order. Commit and push after each numbered item so nothing is lost
if the session ends early.

1. ORDERS STAGE 1 — convert the remaining 25 call sites.
   Find them with:
     grep -rn "order\.status *= *'" backend/domains --include=*.js | grep -v tests
   They are in: merchant.routes.js (10), paymentProcessing.service.js (5),
   payment.routes.js (3), merchant.assignment.routes.js (3),
   disputeResolution.admin.routes.js (1), paymentOrder.routes.js (2 remaining).

   For each site: read the surrounding logic, decide which named transition it
   is, and replace `order.status = 'X'; ... order.save()` with the matching
   call. Fields that belong WITH the transition go in `set` so they land in the
   same update. If money moves, the transition must come FIRST and gate it —
   see the converted site in paymentOrder.routes.js for the shape.

   Watch for: `const order` being reassigned (use a new variable for the
   post-transition document), sites already inside a mongoose session (pass it
   through), and handlers that returned 400 for "already X" where 409 is now
   more accurate.

2. ORDERS STAGE 2 — backend/postgres/orderPgAuthority.js.
   Follow backend/postgres/settlementPgAuthority.js exactly: onPostgres()
   decides, orderPg.transition() runs when Postgres owns the path, the reverse
   mirror keeps PaymentOrder.status current, a refusal is surfaced not
   swallowed. Only orderLifecycle.service.js should call it — that is the whole
   point of stage 1.

3. ORDERS STAGE 3 — reconcileOrderStates in backend/postgres/reconcile.js
   comparing order_states.state against PaymentOrder.status, with --backfill
   and --repair-mongo following authority like every other check there. Add the
   cross-store integration test. Model it on
   backend/tests/integration/settlementBonusCrossStore.integration.test.js.
   NOTE: payment_orders stays a MIRROR (overwritten, no history); order_states
   plus order_transitions are the authoritative lifecycle. Do not conflate them.

4. LEDGER ROUTING — route revenueSettlement.service.js through the resolver.
   Unblocked once Orders is authoritative, because order state produces most
   ledger events.

5. TASK H — KYC, the eleventh and last domain. Two parts:
   (a) the Postgres KYC authority with concurrency tests and a reconcile leg —
       it is the only domain with concurrencyTested: false;
   (b) move the actual KYC documents to Cloudflare R2 or another
       S3-compatible store. Neither database should hold blobs.
   KYC cuts over LAST by design; do not reorder it.

RULES THAT ARE NOT NEGOTIABLE — they found four real bugs in this codebase:
  - Never mark an item PASS based only on code inspection. Run it.
  - Mark anything unverified as NOT VERIFIED rather than assuming success.
  - Do not change an authority flag until the implementation, tests,
    reconciliation, observability and rollback path all exist AND CI has run
    green. CI evidence, not local evidence.
  - Mutation-test every fix: break the code, confirm a test fails, restore it.
    Report which mutation failed which test.
  - Any new transaction block needs a concurrency test for deadlocks and pool
    exhaustion.
  - Do not hide incomplete work behind configuration flags.
  - Do NOT disable the ordering gate in moneyAuthority.js. It is what stops a
    bet living in Postgres while the order that funded it lives in Mongo.
    Completing the domains opens it; forcing it hides that they are not done.
  - If you find an architectural decision likely to cause failures at scale,
    stop and document it with a proposed design before implementing.

Two traps that cost CI runs last session:
  - Fire-and-forget mirrors mean tests must POLL, not read once. Waiting for
    the first of two ordered async writes does not mean the second landed.
  - The sandbox cannot run MongoDB, so integration tests are unverifiable
    locally and WILL need fixture fixes on their first CI run. Expect it.

Tell me at the end: what you ran, what passed, and what you did NOT verify.
```
