# Load testing the bet path

One question, and it is a launch gate: **at what rate does a single `Cycle`
document stop absorbing bets?**

Everything else about this platform scales by adding instances. The bet write
does not. Every bet on a cycle updates the same document
(`domains/markets/bet.routes.js`), MongoDB locks at document granularity, and
`docs/governance/LATENCY.md` records that the height of that ceiling is
unmeasured. This directory measures it.

> **This has not been run.** The harness is written and reviewed; no numbers
> exist yet. It could not be executed in the environment it was authored in
> (no `mongod` — the binary download is blocked by network policy — and no
> deployed instance). Treat any statement about where the knee sits as
> unverified until you run it.

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

## Recording the result

When you have numbers, put them in `docs/governance/LATENCY.md` under
"horizontal scaling" and replace the "unmeasured" note. That file currently
says the ceiling is unknown; it should not keep saying that after a run.
