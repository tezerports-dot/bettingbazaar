# Routing bet settlement: one bulk statement vs. N transactions

**Status: proposed design. NOT implemented.** Written under the standing rule —
*if you discover an architectural decision likely to cause failures at scale,
stop and document it with a proposed design before implementing a fix.* This is
one, and it is the last thing standing between BETS and `implemented: true`.

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

## Until then

`BETS` stays `implemented: false`. The other three legs are real — mirrored,
reconciled cross-store, reverse-mirrored — and placement is routed. What is
missing is precisely this, and the flag says so rather than claiming a routing
that covers half the lifecycle.
