# Load testing the bet path

One question, and it is a launch gate: **at what rate does a single `Cycle`
document stop absorbing bets?**

Everything else about this platform scales by adding instances. The bet write
does not. Every bet on a cycle updates the same document
(`domains/markets/bet.routes.js`), MongoDB locks at document granularity, and
`docs/governance/LATENCY.md` records that the height of that ceiling is
unmeasured. This directory measures it.

> **The Mongo ceiling has not been measured.** The harness is written and
> reviewed; no numbers exist for the `Cycle` document. It cannot be executed
> where it was authored (no `mongod` — the binary download is blocked by network
> policy — and no deployed instance). Treat any statement about where that knee
> sits as unverified until you run it.
>
> **The PostgreSQL bet path HAS been measured** — see "The per-cycle lock,
> measured" below. That path needs no MongoDB, so it runs against a local
> PostgreSQL, and it already found and fixed a ceiling.

## Never point this at production

It places **real bets** against a **real cycle** using **real balances**.
Staging only.

## Run it

```bash
# 1. Mint throwaway funded accounts against staging. Prints TOKENS=...
BASE_URL=https://staging.example.com npm run loadtest:seed

# 2. Find an OPEN cycle (admin panel, or GET /api/v1/game/cycles).
#    A 30-minute cycle gives you a ~25-minute window before it closes.

# 3. Run
BASE_URL=https://staging.example.com \
CYCLE_ID=cycle_30m_1753... \
TOKENS=<paste from step 1> \
k6 run loadtest/bet-contention.js
```

`k6` is a single static binary — `brew install k6`, or
`docker run -i --rm grafana/k6 run - < loadtest/bet-contention.js`.

## The experiment is the comparison, not the number

A single run cannot tell you *what* the bottleneck is. Run it twice:

| Observation | Meaning | What to do |
|---|---|---|
| 2 instances ≈ **2× throughput** | The app tier is the limit. Mongo is nowhere near saturated. | Nothing. Do **not** rewrite the bet path. |
| 2 instances ≈ **same throughput** | The `Cycle` document is the ceiling. | Sharded counters, or move the guard to Postgres. |

That comparison is the whole point. A one-instance number cannot distinguish
"one Node process is the limit" from "one Mongo document is the limit", and
those have opposite fixes — one is free, the other is a rewrite of the money
hot path.

## Why latency and not errors

WiredTiger uses optimistic concurrency. The loser of a write race gets a
`WriteConflictError` and MongoDB **retries it internally**. So contention never
shows up as failed requests — it shows up as p99 latency, past a threshold.

**A run with a 100% success rate can still be past the knee.** Plot p99
against achieved rate and look for where the curve bends.

## Confounders to rule out before believing a knee

Check these first, or you will "discover" a bottleneck that is really a
config setting:

1. **Rate limiting.** `bet` tier is 30/min per user (`RATE_LIMITS.md`). The
   script checks for 429s; if you see any, the limiter is your ceiling, not
   Mongo. Raise the tier or add accounts.
2. **Load shedding.** `middleware/loadShed.js` returns 503 past a configured
   in-flight ceiling. Watch `bb_requests_shed_total`.
3. **Connection pool.** Default 10 per instance. If p99 rises while Mongo's
   own metrics look idle, you are queueing for a connection, not a document.
4. **Argon2 on the login path.** Don't include logins in the run — ~80 ms each
   on a 4-thread libuv pool would dominate the measurement. The script uses
   pre-minted tokens for exactly this reason.

## Server-side signals worth capturing during the run

```js
// mongosh, against the staging cluster
db.serverStatus().wiredTiger.concurrentTransactions.write   // "out" climbing toward 128 = saturated
db.serverStatus().metrics.operation.writeConflicts          // the retry count — rising = real contention
```

Plus the app's own `/metrics`: `http_request_duration_seconds`,
`bb_pg_pool_connections{state="waiting"}`, `bb_requests_shed_total`.

## The per-cycle lock, measured

`betPg.placeBet` takes a per-cycle advisory lock so a stake cannot commit onto a
cycle whose settlement has already opened. That lock is also, unavoidably, a
throughput question — and the answer was bad enough to change the design.

Measured against a real PostgreSQL 16, one Node process, 1,200 bets across 200
distinct users. **Relative numbers only:** client and server share a box, so the
absolute rate is not a capacity claim. The comparison between rows is the result.

| Bets spread over | Concurrency | Exclusive lock | Shared lock |
|---|---|---|---|
| 1 cycle | 1 | 521/s | 527/s |
| 1 cycle | 8 | **418/s** | **2,113/s** |
| 1 cycle | 32 | **419/s** | 2,060/s |
| 3 cycles | 8 | 1,488/s | 2,397/s |
| 32 cycles | 32 | 2,535/s | 2,360/s |

Read the exclusive column first. One cycle was *slower at concurrency 8 than at
concurrency 1* — more concurrency, less throughput. That is not a pool or a disk;
it is a queue. The lock was held for the whole bet transaction, so every bet on a
cycle waited for every other one, and a single cycle was pinned near 420/s no
matter what was offered it. Three cycles reached 1,488/s, which confirms the
ceiling was per cycle rather than the machine.

**That target is 500–800 bets/sec against ONE cycle** — the number this
directory exists to test. The lock was sitting below it.

The fix is that bets take the lock **shared** and `openSettlement` takes it
**exclusive**. Bets need to exclude the settlement, never each other: two bets on
one cycle contend on their own wallet rows and nothing else. Shared holders do
not conflict with each other but do conflict with an exclusive holder, so every
property the lock was added for survives — a settlement still waits for in-flight
bets, and a bet arriving mid-settlement still blocks and then refuses with
`cycle_settling`. Both directions are pinned in `betSettlementRace.pg.test.js`;
the second test times out rather than fails if the lock reverts to exclusive.

**Why this matters most on the 1-minute board.** A 30-minute cycle spreads its
traffic over 30 minutes; a 1-minute cycle puts a whole board's traffic through
one cycle id — and therefore one lock — for sixty seconds at a time, then does it
again. Whatever the per-cycle ceiling is, the 1-minute board is the first thing
to hit it.

### What this does NOT tell you

The bet path also writes MongoDB (`Cycle.findOneAndUpdate` with `$inc` on the
pools), and **that** document is the ceiling this directory was built to find.
The numbers above measure the Postgres half in isolation. A full-stack bet is
bounded by the slower of the two, so treat ~2,400/s as an upper bound that the
Mongo write will pull down by an unmeasured amount.

## Recording the result

When you have numbers, put them in `docs/governance/LATENCY.md` under
"horizontal scaling" and replace the "unmeasured" note. That file currently
says the ceiling is unknown; it should not keep saying that after a run.
