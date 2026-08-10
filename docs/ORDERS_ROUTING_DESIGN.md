# Orders routing — the chokepoint for the whole cutover, and why it needs a refactor first

**Status: proposed design. Nothing here is implemented.**

This document exists because of the standing rule in this project: *if you
discover an architectural decision likely to cause failures at scale or make
future maintenance significantly harder, stop and document it with a proposed
design before implementing a fix.* This is one.

---

## Why this blocks everything

The authority resolver refuses Postgres for any path whose dependencies are
still on Mongo. The order of the chain is:

```
ORDERS ──▶ BETS ──▶ SETTLEMENTS
   └────▶ LEDGER
```

Six of eleven domains are fully built, routed, reconciled and reversible. None
of them can carry authority, and every one of them reports the same root cause:
**Orders is still Mongo-authoritative.** `LEDGER` is in the same position for a
related reason — order state produces most ledger events, so routing the ledger
before orders would move the consequence while leaving the cause behind.

So Orders is not one domain among eleven. It is the gate.

## Why it is not a normal routing job

Every domain routed so far had **one or two choke points**, and that is what
made each of them a contained change:

| Domain | Choke point |
|---|---|
| Wallet | `WalletLedger` post-save — every movement writes exactly one row |
| Merchant settlement | `withdrawalHold.service` — one settle, one reverse |
| Admin issuance | Two admin mint routes |
| Bets | `bet.routes` placement |
| Sports settlement | `gameEngine` — exactly two state moments |
| Bonuses | `BonusRecord` — one collection every giveaway already writes |

Orders has none. Measured on the current tree:

- **31 order status writes** across **8 files**
- **48 `PaymentOrder` mutation sites** in total across 19 files

```
6  domains/payment/withdrawalHold.service.js
6  domains/payment/paymentProcessing.service.js
6  domains/merchant/merchant.routes.js
5  domains/merchant/merchant.assignment.routes.js
4  domains/analytics/analytics.admin.routes.js
2  domains/payment/paymentOrder.routes.js
1  domains/operations/operations.admin.routes.js
1  domains/merchant/merchant.admin.routes.js
```

There is no seam to put the resolver behind. Wiring an adapter into some of
those call sites and not others produces a system where **some order
transitions are authoritative in Postgres and others in Mongo** — which is
strictly worse than either store owning the whole lifecycle, because no
reconciliation can distinguish "these two stores disagree" from "these two
stores are each right about different transitions".

That is the failure this document exists to prevent.

## The finding, stated plainly

`orderPg.js` already models the lifecycle properly: `order_states` plus
append-only `order_transitions`, expected-previous-state guards in the `UPDATE`,
and the accounting event posted in the **same transaction** as the state change.
It has 22 tests including a 100-copy callback storm and 60 concurrent
completions. The Postgres side is not the problem.

The problem is that the Mongo side never had a state machine at all. An order's
status is a string field that any of 31 places may assign, with no guard that
the transition it represents was legal from the state the order was actually in.
`orderPg.transition()` refuses an illegal move; `PaymentOrder.updateOne({...},
{status: 'COMPLETED'})` cannot refuse anything.

**This is a live correctness issue, not only a migration obstacle.** A
cancelled order can be completed today. An expired one can be paid. Nothing in
the Mongo path stops it — the protection that exists is incidental ordering in
the routes, not an invariant.

## Proposed design

Three stages, in order. Each is independently shippable and independently
revertable, and **no authority flag moves until all three are done.**

### Stage 1 — build the seam (no behaviour change)

Add `domains/payment/orderLifecycle.service.js`: one function per legal
transition, each taking `(orderId, context)` and performing the Mongo update
with the expected-previous-state guard **in the query**:

```js
PaymentOrder.findOneAndUpdate(
  { _id: orderId, status: { $in: LEGAL_FROM[to] } },
  { $set: { status: to, ...fields } },
  { new: true },
)
```

A null result means the transition was illegal *or* someone else won the race —
the same distinction `orderPg.transition()` already draws, resolved the same way.

Then replace all 31 call sites with calls to it. This is mechanical, and it is
where the review effort belongs: each site has to be read to determine which
transition it actually represents.

**This stage is worth doing even if the migration is abandoned.** It closes the
illegal-transition hole in the live Mongo path.

### Stage 2 — route the seam

`orderPgAuthority.js`, following the shape of `settlementPgAuthority.js`:
`onPostgres()` decides, Postgres transitions when it owns the path, the reverse
mirror keeps `PaymentOrder.status` current so the engine and the panels keep
working, and a refusal from Postgres is surfaced rather than swallowed.

Only one file changes in stage 2, because stage 1 created the single seam.

### Stage 3 — reconcile order state cross-store

`reconcileOrderStates`, comparing `order_states.state` against
`PaymentOrder.status`, with `--backfill` and `--repair-mongo` following
authority the way every other check in `reconcile.js` does. Plus the
integration suite that proves it, which is what `reconciled` asserts.

`payment_orders` stays a mirror — overwritten in place, no history, no guard.
`order_states` + `order_transitions` are the authoritative lifecycle. Those are
different tables on purpose and stage 3 must not conflate them.

## Estimated shape of the work

| Stage | Files touched | Risk |
|---|---|---|
| 1 — seam | 8 call-site files + 1 new service | Medium: 31 sites, each needs reading |
| 2 — route | 1 new adapter + the seam | Low, given stage 1 |
| 3 — reconcile | `reconcile.js`, `reverseMirror.js`, 1 suite | Low |

Stage 1 is the one that needs care and is not safe to rush. It is also the one
with standalone value.

## What this means for the launch

**Launching on MongoDB does not require any of this.** Every money path defaults
to Mongo and works today. This is the migration's critical path, not the
launch's.

The one item above that is a *live* concern is the illegal-transition hole in
stage 1's description. It has been there since the order routes were written and
is not a regression, but it is worth knowing about before taking real money:
the ordering of checks in the routes is what currently prevents a cancelled
order being completed, and ordering is not an invariant.
