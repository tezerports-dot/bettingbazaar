# Routing bet settlement: one bulk statement vs. N transactions

**Status: IMPLEMENTED.** Shipped at `1bd5de8`; `BETS.implemented` flipped on the
CI evidence of run 31456526949, all eight jobs green including the integration
leg. The rest of this document is kept as written — the design, the objection
that turned out to be wrong, and the three blockers — because the record of what
was believed before the work is more useful than a tidy summary after it.

## What was actually built

Both sides route from **one decision, read once per settlement pass** and passed
down. `gameEngine.processPayoutsOptimized` calls `onPostgres()` a single time
and hands the answer to `executeSettlementBatch`; the winning side never asks
again. That is what makes all-or-nothing structural rather than a convention —
and it is tested, including on the mid-cursor batch flush, which a mutation
found was not covered at first.

| | Mongo branch | Postgres branch |
|---|---|---|
| losing side | `unlockLostBet` per bet, then one `updateMany` | `settleBetOnPostgres(LOST)` per bet |
| winning side | `creditWinnings` + `releaseLockedStake` per user, then `bulkWrite` | `settleBetOnPostgres(WON)` per bet |
| `Transaction` log | written | written |
| phantom bets | `updateMany` | `updateMany` |

The bulk statements and the wallet calls are **suppressed** on the Postgres
branch, not merely redundant there. `betPg` composes the transition and the
money into one transaction, so calling the wallet helpers as well would move the
money twice; and the reverse mirror has already written each status, so
re-stamping would overwrite the bets Postgres deliberately REFUSED — turning a
reported failure into a silent one, and marking WON a bet whose payout never
moved.

### The three blockers, resolved

**(a)** The aggregation projects the funding split under the Bet document's own
names now, `fromReserveBalance` included. The readers of `totalLockedDeposit` /
`totalLockedWinnings` moved with it — a mutation confirms that renaming one
without the other is caught.

**(b)** `betStamps` carries the bet document. The fields the aggregation cannot
know per bet (user, cycle, side) come from the group key and the cycle.

**(c) DECIDED: the `Transaction` log stays Mongo-side and runs on both
branches.** It is the user's history feed, not the ledger. Double entry lives in
`accounting_events` and the per-wallet movement in `wallet_ledger`, and on the
Postgres branch `betPg` writes both inside the settling transaction — so the
auditable record of the payout is already authoritative there. Skipping it under
Postgres authority would buy no consistency and would delete winners' payouts
from their own transaction history. It reaches Postgres by the ordinary
dual-write leg (`mirrorTransaction`), which is the right relationship for a
projection.

> **Known and unchanged by this routing:** those are bare inserts with no
> idempotency key and no unique index, so a settlement resumed mid-batch writes
> a second `BET_WIN` row for users the first pass already credited. The money is
> safe — `creditWinnings` is keyed — only the history duplicates. Not fixed
> here because the honest fix is a product decision rather than a key: a resumed
> pass pays a *different, smaller* amount for the remaining bets, so upserting
> on (user, cycle) would replace the first row with a partial one, which is
> worse than a duplicate.

### A fourth blocker, found in the wiring

The Mongo path stamps `status`, `payout` and `platformFee` in one `$set`, and
`Cycle.totalPlatformFees` is derived by summing `Bet.platformFee` over the
cycle's WON bets. Routing the first two and leaving the third would make that
number read **zero for every Postgres-settled cycle**, with every state check
still green because no state check looks at the fee.

`bets` therefore carries `platform_fee_paise`. The settling `UPDATE` writes it,
both mirrors carry it, and `reconcileBetStates` selects it so `--repair-mongo`
can restore it. A fractional or negative fee is refused by the code *and* by a
CHECK constraint, on the casino-refund-bound principle: the `if` gives a clean
refusal, the constraint makes the rule a property of the data.

### Two more things running it found

**Phantom bets were being mirrored into Postgres.** They are synthetic —
positive `amount`, zero funding provenance, no balance deduction — so
`betPg.settle` can never settle one (it requires slices summing to the stake).
A mirrored phantom bet would sit PENDING in Postgres forever while Mongo stamped
it LOST, reporting as drift on every cycle, and it inflated
`reconcileUserStakes`' outstanding total against a `lockedBalance` that never
moved. `mirrorBet` skips them, which is what makes the engine's phantom
`updateMany` correctly Mongo-only on both branches.

**`reconcileBetStates`' backfill leg was destroying what it repaired.** It
fetched the Mongo documents with `.select('status')` and handed them to
`mirrorBet`, whose `ON CONFLICT DO UPDATE` writes what it is given — so
repairing a status disagreement **zeroed that bet's payout and retained fee** in
Postgres. Demonstrated against a real PostgreSQL in `betSettlementPg.test.js`
rather than argued; the fix is in the SELECT.

### What was NOT built, and why that is not a gap

Option B below — one transaction per *user* rather than per bet — is still the
better shape at scale and is **not** implemented. Per-bet is what makes "a
settled bet with no ledger row" structurally unrepresentable, and the corrected
analysis shows per-bet is the same order of work the Mongo path already does.
Batching by user is a throughput optimisation to make when a measurement asks
for it, not on an assumption — the last assumption in this document about
settlement throughput was wrong in the other direction.

---

## The situation

`betPgAuthority.js` routes bet PLACEMENT. Settlement still writes Mongo
directly, in two places:

```js
// gameEngine.js — the whole losing side of a cycle, in ONE statement
await Bet.updateMany(
  { cycleId, side: { $ne: cycle.winner }, status: 'PENDING', isPhantom: false },
  { $set: { status: 'LOST' } },
);

// settlementService.js — the winners, as one bulkWrite
await Bet.bulkWrite(stampOps);   // { status: 'WON', payout, platformFee, settledAt }
```

Both are **set-based**: one round trip settles an entire cycle regardless of how
many bets are in it. `Bet.find({cycleId, …})` immediately above the first one
loads that same set, so the population is already known to be unbounded in the
code's own shape.

## CORRECTION — the scale argument below was wrong

**Added after re-reading `gameEngine.js`. The paragraphs that follow overstate
the problem, and the correction makes this job considerably smaller.**

The claim was that routing replaces *one statement* with *N transactions*. That
is not what the code does. The per-bet loop **already exists**, immediately
above the bulk update:

```js
const losingBets = await Bet.find({ cycleId, side: { $ne: winner }, status: 'PENDING' });

for (const bet of losingBets) {                    // ← N sequential awaited
  await unlockLostBet(bet.userId, bet.amount, …);  //   wallet operations, today
}

await Bet.updateMany(…, { $set: { status: 'LOST' } });   // ← only the status stamp
```

So the Mongo path already performs N awaited wallet operations per cycle. The
`updateMany` is a status stamp layered on top of work that is already per-bet.

Routing to `betPg.loseBet` therefore replaces **N wallet ops + 1 bulk stamp**
with **N transactions that do both atomically**. That is the same order of work
and arguably fewer round trips, not a new N. The throughput objection does not
hold, and neither does the "hot path of a game loop" framing — the loop is
already there.

What remains true and still matters:

- **It must be all-or-nothing.** Routing the losing side and not the winning
  side leaves some bet transitions authoritative in Postgres and others in
  Mongo — the exact split `docs/ORDERS_ROUTING_DESIGN.md` exists to prevent, and
  which no reconciliation can tell apart from genuine disagreement.
- **Option B below is still the better shape**, now for atomicity rather than
  throughput: one transaction per user, locking that user's wallet once, keeps
  the state change and the payout together without inverting the lock ordering.
- **`slicesFromBet` is required on every settle.** `betPg.settle` refuses to
  return a stake without its funding provenance, deliberately — returning a
  deposit-funded stake into `winningsBalance` is a cash-out route.

I am leaving the original analysis below rather than deleting it, because the
mistake is instructive: I reasoned about the shape of the *statement* rather
than the shape of the *loop around it*, and concluded a tractable change was
dangerous. Reading one function further up would have shown it.

---

## Why this is not the same job as the other domains

Every settlement path routed so far moved a bounded number of rows per call —
one order, one settlement, one grant. `betPg.winBet` / `loseBet` are the same
shape: **one bet, one transaction**, each taking a wallet row lock to consume
the stake and credit the payout atomically.

Routing settlement naively means replacing one statement with **N transactions**,
each with its own `BEGIN`, its own wallet lock and its own pooled connection.
For a cycle with a few thousand bets that is a few thousand serialised
round trips on the hot path of the game loop, holding the pool for the duration
and blocking every concurrent placement behind it.

That is a performance regression severe enough to be a correctness problem: the
game engine settles on a timer, and a settlement pass that no longer finishes
before the next cycle opens leaves stakes locked with nothing coming to release
them — the exact failure `findIncompleteSettlements` exists to detect.

**So this is not a mechanical port, and doing it hastily on the highest-traffic
money path in the system is how the migration would break something.**

## What makes it tractable rather than blocked

Three properties of the existing code that a design can lean on:

1. **The losing side moves no money at settlement time.** `unlockLostBet` runs
   in the loop *above* the `updateMany`; the bulk statement only stamps status.
   So the losing side is a pure state transition and could be a single
   set-based `UPDATE … WHERE cycle_id = $1 AND side <> $2 AND status = 'PENDING'`
   in Postgres — one statement, not N.
2. **The winning side already batches.** `settlementService` accumulates
   `userOps` and flushes at `BATCH_SIZE`, so a batched Postgres path fits the
   shape that is there rather than fighting it.
3. **`reconcileBetStates` already covers the gap.** The forward mirror cannot
   see `updateMany` — Mongoose gives a bulk update no documents to hand a post
   hook — so those transitions reach Postgres through the reconcile pass today.
   That is why `--backfill` is the *expected* Phase A mode for bets rather than
   an emergency repair, and it means a partially-routed settlement is visible
   rather than silent.

## Proposed design

Add a **set-based settlement** to `betPg.js`, alongside the per-bet functions
rather than replacing them:

```js
// One statement. The guard is in the WHERE, as everywhere else.
loseCycle({ cycleId, winningSide })   // PENDING → LOST for the losing side
winCycle({ cycleId, stamps })         // PENDING → WON, payout per bet, batched
```

`loseCycle` is a single `UPDATE … RETURNING bet_id`, because the losing side
consumes no stake at that moment. `winCycle` takes the stamps the settlement
service already computes and applies them with one `UPDATE … FROM (VALUES …)`
per batch, inside one transaction per batch rather than per bet.

`betPgAuthority` then grows `settleCycleOnPostgres()` with the usual shape —
`handled: false` when Mongo owns the path, a surfaced refusal otherwise — and
the two call sites ask it once each.

### The open question this design does not settle

Per-bet money movement on the winning side. `winBet` composes the payout credit
into the bet's own transaction, which is the property that makes a settled bet
with no ledger row unrepresentable. A batched `winCycle` cannot hold one wallet
lock per bet inside one transaction without inverting the codebase's fixed lock
ordering and risking deadlock.

Two options, and this is the decision that needs making before code:

| | keeps atomicity | keeps throughput |
|---|---|---|
| **A.** Batch the state, move money per bet as today | no — state and payout separate again | yes |
| **B.** One transaction per user (not per bet), locking that user's wallet once and settling all their bets in the cycle together | yes, per user | mostly — bounded by distinct users, not bets |

**B is the better shape** and matches how `settlementService` already groups
(`userOps` is keyed by user). It bounds the transaction count by *distinct
winners* rather than *bets*, which is the number that actually matters, and it
keeps the wallet-lock-per-transaction invariant intact.

Recommended: implement B, and benchmark against a cycle with a realistic winner
count before flipping anything.

## Attempted, reverted, and what actually blocks it

`settleBetOnPostgres` is BUILT (`postgres/betPgAuthority.js`) and both call sites
were wired, then reverted. Three obstacles turned up in the wiring that the
design above did not anticipate, and shipping past them would have been worse
than not shipping.

**1. The winner aggregation does not carry the funding provenance the settle
needs.** `gameEngine` groups winners with:

```js
bets: { $push: { betId: "$_id", amount: "$amount",
                 fromDeposit: "$fromDepositBalance",
                 fromWinnings: "$fromWinningsBalance" } }
```

Two problems. The field names are not the Bet document's, so `slicesFromBet`
reads `undefined` from them. And **`fromReserveBalance` is not projected at
all** — `betPg.settle`'s `requireSlices` demands the slices sum exactly to the
stake, so a reserve-funded bet would throw rather than settle.

**2. `betStamps` carries `{betId, payout, platformFee}` and no bet.** The
adapter needs the document for its slices. Plumbing it through is small, but it
has to happen before either side can route.

**3. The winning path also writes a `Transaction` log** (`txOps`) that the
Postgres branch would skip. Whether that log should follow authority or stay
Mongo-side is a decision, not an oversight to paper over.

### A concern raised here earlier, now measured and WITHDRAWN

An earlier version of this section suggested that a bet funded partly from
`reserveBalance` might have its locked stake under-released on the live Mongo
path, because `totalLockedDeposit + totalLockedWinnings` sums to less than the
stake. **That is not a bug, and the reasoning was wrong.**

`releaseLockedStake` releases the stake with `amount`, not with the slices:

```js
$inc: {
  lockedBalance:        -amount,            // ← the FULL stake
  lockedDepositAmount:  -(fromDeposit  || 0),
  lockedWinningsAmount: -(fromWinnings || 0),
}
```

`amount` is `op.totalBetAmount`, summed as `$sum: "$amount"` over the winning
bets — the whole stake. So the player's locked money comes back in full
regardless of which pockets funded it.

The two slice arguments only adjust the PROVENANCE counters, and there are
exactly two of those (`lockedDepositAmount`, `lockedWinningsAmount`). Reserve
deliberately has none — `betPg`'s `LOCK_PROVENANCE` says so in as many words.
So the asymmetry is symmetric: the same two counters move on lock and on
release, and nothing is lost.

Recorded rather than deleted because the mistake is the same shape as the one
above it — reasoning about the arguments to a call without reading what the call
does with them.

What remains true is the narrower point: `betPg.settle` requires slices that sum
to the STAKE, so the missing `fromReserveBalance` in the aggregation still blocks
routing. That is a constraint of the Postgres path, not a defect in the Mongo one.

## ~~Until then~~ — resolved, see the top of this file

> `BETS` stays `implemented: false`. The other three legs are real — mirrored,
> reconciled cross-store, reverse-mirrored — and placement is routed. What is
> missing is precisely this, and the flag says so rather than claiming a routing
> that covers half the lifecycle.

All three blockers are cleared and settlement is routed on both sides.
`implemented: true` at `1bd5de8`, on CI run 31456526949.

With that, **11 of 11 money paths are cutover-eligible** and the resolver
returns Postgres for all eleven when every `MONEY_AUTHORITY_*` is set — the
ordering gate satisfied by completing the domains rather than by being
disabled. `infrastructureTested` remains 0/11 and is the only thing between
eligible and *certified*; it is a staging campaign, not code.
