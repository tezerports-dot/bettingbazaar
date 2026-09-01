# The requeue cycle, and why a transition key cannot be derived from its destination

**Status: found, measured, and fixed in `postgres/orderPg.js`. This document is
the decision record, because the fix changes a rule every future caller obeys.**

Found while converting the last unguarded order status write in Stage 1
(`merchant.routes.js`, the merchant-reject handler). Written under the standing
rule: *if you discover an architectural decision likely to cause failures at
scale, stop and document it with a proposed design before implementing a fix.*

---

## What was wrong

Two statements in this codebase contradicted each other, and both were asserted
by tests.

`postgres/orderPg.js` said, as a comment on `ALLOWED_FROM` and as an exception
in `transition()`:

> A terminal state accepts nothing — there is no entry for `PENDING_QUEUE`
> because nothing transitions INTO it; that is where an order is opened.

`domains/merchant/merchant.routes.js` disagreed, in production, on the reject
path:

```js
order.merchantId       = null;
order.merchantSnapshot = null;
order.status           = 'PENDING_QUEUE';   // ← the transition that "does not exist"
const reAssigned = await tryAssignMerchant(order);
```

That is not an edge case. It is what rejecting *means*: the merchant declines,
the order returns to the queue, and the next-best merchant is offered it. The
rule table was wrong; the route was right.

## The consequence, measured

Adding the missing edge is a one-line change. It exposes a second defect that is
not.

`order_transitions.tx_id` is `UNIQUE`, and `transition()` derived it from the
order and the **destination**:

```js
const transitionTxId = txId || `ord_${oid}_${to}`;
```

On an acyclic graph, one key per (order, target state) is exactly right. With a
cycle, the same pair is legitimately reached twice — and the second arrival
collides with the first.

Run against a real PostgreSQL 16, before the fix:

```
1. opened                      -> PENDING_QUEUE
2. assign to m1                -> ASSIGNED       {ok:true, idempotent:false}
3. merchant rejects, requeued  -> PENDING_QUEUE
4. assign to m2                -> PENDING_QUEUE  {ok:true, idempotent:true}

RESULT: state = PENDING_QUEUE | merchant = m1
>>> REASSIGNMENT SILENTLY LOST
```

The second assignment returned **`ok: true`**. Not an error, not a refusal — the
"someone already did this, nothing to do" answer. The order stayed in the queue,
still carrying the first merchant's id, and nothing anywhere raised a fault.

Every rejected order would have failed to reassign, permanently, and the only
symptom would have been orders quietly aging in `PENDING_QUEUE`.

## Why the obvious fixes are wrong

**Include `from_state` in the key** (`ord_<order>_<from>_<to>`). Distinguishes
requeue from assignment, but a *second* reject/reassign cycle collides again.
Merchants can decline repeatedly; this moves the failure from the first cycle to
the second and makes it rarer, which is worse — a bug that survives testing and
appears in production.

**Add an occurrence counter by default** (`ord_<order>_<to>_<n>`, computed under
the row lock). This works for the cycle and destroys retry protection everywhere
else: a duplicate provider callback would compute a *new* `n`, insert a second
row, and advance the order twice. Trading a rare silent stall for a common
double-apply on a money path is not a trade.

## The decision

**An idempotency key must describe the event, not the destination.**

Only the caller can tell one merchant double-clicking reject from two different
merchants declining in turn. That difference is invisible from `(order, state)`,
and no derivation from the destination will ever recover it.

So `transition()` now **refuses**, loudly, a transition into a re-enterable
state that brings no key of its own:

```js
if (!txId && REVISITABLE.includes(to)) throw new Error(...)
```

`REVISITABLE` is *derived from the graph* — a depth-first search for states
reachable from themselves — not hand-listed, so adding an edge later cannot
leave it stale. Today it computes to exactly `['PENDING_QUEUE', 'ASSIGNED']`,
and there is a test asserting that so a widening of the graph is visible in the
diff rather than discovered in production.

A throw is the only outcome that cannot be mistaken for success. Minting a
unique key by default would have made the call *appear* to work while dropping
the protection every other edge depends on — which is the same class of failure
as the bug being fixed.

### What this costs

Callers on those two edges must supply a key. That is a real cost and it is the
point: the key is a decision about what counts as the same event, and it belongs
to the layer that knows. Every call site pays it, and that is correct: a
transition without an explicit key is a transition whose idempotency nobody has
thought about.

## Verification

Everything below was **run**, against PostgreSQL 16 locally.

| Check | Result |
|---|---|
| `REVISITABLE` derivation | computes `['PENDING_QUEUE','ASSIGNED']` |
| reject → requeue → reassign to a different merchant | order reaches `ASSIGNED` holding `m2` |
| 50 concurrent copies of one reassignment | applied exactly once |
| stale replay after a second requeue | refused by the key, order stays `PENDING_QUEUE` |
| duplicate callback on non-cyclic edges | still collapses to `idempotent: true` |
| `backend/tests/postgres/` | 289 passed |

Mutations, each reverted after:

| Mutation | Tests killed |
|---|---|
| `REVISITABLE` derived from `[]` (no cycle detection) | 2 — the derivation assertion and the missing-key refusal |
| `PENDING_QUEUE: [ASSIGNED]` edge removed | 5 — the whole requeue group |
| `tx_id` randomised per call | 3 — the stale-replay gate and both ledger-key tests |

The third mutation is worth recording for what it did **not** kill. The
100-copy callback storm and the same-key replay both survived it, because a
replay arriving while the order still sits in its target state is caught earlier
— by the same-state short-circuit under the row lock — and never reaches the
key. The `UNIQUE tx_id` is load-bearing only for a duplicate that arrives after
the order has moved on and the state guard would re-admit it. The test named
`refuses a stale assignment replay that the state guard would re-admit` was
added specifically to cover that, and it does kill the mutation.

## The rest of the rule table was also wrong

The requeue edge was the first missing edge, not the only one. Converting the
remaining call sites meant reading what each one actually does, and four
transitions the live routes perform every day had no entry in `ALLOWED_FROM`. Each is recorded at its line in `orderPg.js`.

| Edge added | The route that already does it | What it was |
|---|---|---|
| `PENDING_QUEUE ← ASSIGNED` | merchant reject → requeue | the cycle above |
| `PROCESSING ← PENDING_QUEUE` | merchant accepts from the open pool, unassigned | claimable orders |
| `CANCELLED ← PAID` | merchant rejects a PAID order | behaviour preserved, see below |
| `COMPLETED ← DISPUTED`, `CANCELLED ← DISPUTED` | both admin dispute-resolve routes | **a shipped bug** |

The last row is the serious one. **`DISPUTED` had no outgoing edges at all** —
`nextStates('DISPUTED')` returned `[]`. Both resolve routes confirm the order is
`DISPUTED` and then ask for `COMPLETED` or `CANCELLED`, so the guarded update
matched no row and the handler returned 409 for the one status it exists to
handle. Every admin dispute resolution refused itself. A disputed order could be
created and never resolved.

This shipped in the stage-1 seam: the converted `paymentOrder.routes.js` resolve
handler was the reference the remaining conversions were to be modelled on, and
it could not succeed. Reading it did not reveal that; asking the rule table
`canTransition('DISPUTED','COMPLETED')` did.

### The ledger key, which the dispute cycle broke in turn

Making `COMPLETED` reachable from `DISPUTED` put `COMPLETED` and `DISPUTED` on a
cycle — an order completes, is disputed, and the dispute is resolved back in the
merchant's favour. So `COMPLETED` became revisitable, and a second visit needs
its own transition key by the rule above.

The ledger key was derived from that transition key (`acct_${transitionTxId}`),
which meant a new transition key produced a **new accounting event**. Measured:
a 70 000-paise deposit completed, disputed, and re-completed left `USER_FUNDS`
at 140 000. The books double-counted the deposit.

A transition is an *event* and may legitimately repeat. The accounting fact
"this order's deposit completed" happens **once per order**, however many times
the state machine passes back through `COMPLETED`. Those are different things
and were being derived from the same string. The ledger key is now
`acct_ord_<order>_<state>` — keyed on the order and the state, never on the
transition — so the `ON CONFLICT DO NOTHING` turns the repeat into the no-op it
always should have been.

Mutation: reverting the ledger key to `acct_${transitionTxId}` fails
`resolves a dispute on a completed order without double-posting the ledger`
with `expected 140000 to be 70000`.

### The static check became a runtime one

Requiring a key for every `COMPLETED` transition — the overwhelmingly common
one — because `COMPLETED` *can* repeat would have been a poor trade. The check
now fires only when the default key would **actually** collide: inside the
transaction, under the order's row lock, it asks whether this order has been in
this state before and refuses only then. A first completion needs no key; a
second one does. `REVISITABLE` remains as the derived description of which
states could ever need it, and the test asserting its contents is what makes a
future widening of the graph visible in the diff.

## Follow-up, deliberately not bundled here

`CANCELLED ← PAID` was added to preserve behaviour, not because it is right. The
table's own distinction is `CANCELLED` for an order abandoned before payment was
asserted and `FAILED` for one where payment **was** asserted and did not check
out — and a merchant rejecting a PAID order is squarely the second. Changing
which status those orders land in is a user-visible change to every panel,
filter and count that reads it, so it does not belong in a stage whose contract
is "no behaviour change".

One behaviour change was made deliberately: the merchant dispute route accepted
`ASSIGNED`, and now does not. An order nobody has started working on has nothing
to dispute, `ALLOWED_FROM[DISPUTED]` never admitted it, and leaving the route
accepting a transition Postgres would refuse is precisely the disagreement no
reconciliation can tell apart from real drift.

## What is NOT addressed here

`payment_orders` remains a mirror — overwritten in place, no history, no guard.
`order_states` + `order_transitions` are the authoritative lifecycle. This
document is about the latter. Stage 3's reconciliation must not conflate them.
