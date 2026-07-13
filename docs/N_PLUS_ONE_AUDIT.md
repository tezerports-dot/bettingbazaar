# N+1 Query Audit + Eager-Loading Convention (item 6) — 2026-07-13

**Finding: the codebase already uses eager/batch loading throughout. No read-side
N+1 pattern exists to fix.** This document records the audit method, the evidence,
and the convention so future code keeps the property.

## What an N+1 is (and what it is NOT)

An **N+1 read** is: fetch a list (1 query), then fire one MORE query *per row* to
enrich it — N+1 total. The fix is **eager loading**: collect the related keys and
fetch them in ONE batched query (`{ _id: { $in: ids } }`), or `.populate()` the
ref, then join in memory.

A **per-item WRITE loop is NOT an N+1** and must not be "fixed" by batching blindly:
settlement credits each winner and marks each bet with its OWN idempotency key and
its OWN ledger event inside a transaction. Those writes are intentionally discrete
(that is what makes them idempotent and crash-safe). Collapsing them would break the
money guarantees CI proves.

## Method

Searched every `for (…of…)`, `.map(`, `.forEach(` body in `backend/**/*.js` for an
awaited query keyed by the loop variable (the N+1 signature):

```
# per-row point lookups inside loops (the thing we do NOT want)
rg -nU 'for\s*\(\s*const\s+(\w+)\s+of[\s\S]{0,300}?await\s+\w+\.(findById|findOne)\s*\(' backend
# enrichment queries near iteration
rg -nU '(for\s*\(|\.forEach\(|\.map\()[\s\S]{0,250}?await\s+\w+\.(find|populate|aggregate)\b' backend
```

## Evidence — eager loading is the established pattern

Every read-enrichment site collects IDs first, then does ONE batched query:

| Site | Pattern (all single batched queries) |
|---|---|
| `reporting.service.js` `settlementReport` | `Merchant.find(...)` → `nameById` Map, then orders/bonuses joined **in memory** (no per-row query) |
| `routes/winners.routes.js:59` | `User.find({ _id: { $in: realUserIds } })` |
| `domains/markets/gameEngine.js:305,414` | `User.find({ _id: { $in: winnerIds } })`, `Referral.find({ userId: { $in: winnerIds } })` |
| `routes/referral.routes.js` | F1/F2/F3 as **3 batched** `$in` queries, not per-referral |
| `routes/admin/users.admin.routes.js:400` | `Cycle.find({ cycleId: { $in: cycleIds } })` |
| `routes/admin/system.admin.routes.js:405` | `User.find({ _id: { $in: userIds } })` |
| `domains/merchant/merchant.admin.routes.js:24` | `User.find({ _id: { $in: userIds } })` |
| `routes/retention.routes.js:56` | `User.find({ _id: { $in: userIds } })` |

Ref-heavy **list** endpoints use `.populate(field, 'projection')` — a single extra
query (or server-side `$lookup`), never one-per-row: disputes, payment orders,
UTR registry, merchant assignment, game transactions, config-version history.

The `findById`/`findOne` calls that appear across services are **single
request-scoped lookups** (one authenticated user/merchant/order per request), not
loop-driven — e.g. `auth.middleware.js` `User.findById(decoded.userId)`,
`merchant.routes.js` `PaymentOrder.findById(req.params.id)`. Not N+1.

## The loops that DO run a query per item — and why they're correct

| Site | Why it's not an N+1 to "fix" |
|---|---|
| `wallet.service.js` `settleWins` | per-winner `creditWinnings` + `Bet.findByIdAndUpdate` — discrete idempotent **writes** inside one transaction |
| `revenueSettlement.service.js` `reconcile*` | per-order / per-cycle `recordAccountingEvent` — discrete idempotent ledger **writes** (`acct_*` keys) |
| `cronJobs.js` result loops | iterate over already-fetched results in memory (no query) |
| `cycleGenerator.service.js:720` | loop bound to the 2 cycle types (`30_MIN`, `FULL_DAY`) — constant, not data-scaled |

## Convention (keep it this way)

1. Enriching a list with related docs → collect keys, ONE `{ $in: keys }` query,
   join in memory (Map), OR `.populate(field, 'only needed fields')`.
2. Never put `await Model.findById/findOne(item…)` inside a `for/map/forEach` over
   data rows. (Per-item *writes* with idempotency keys are the allowed exception.)
3. Always `.select(...)`/project to the fields you need and `.lean()` for read-only
   paths (already the norm here).

Re-run the two `rg` commands above in review; today both return **zero** true
positives (only the constant-bound and write-loop cases above, which are correct).
