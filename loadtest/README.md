# Load testing the bet path

One question, and it is a launch gate: **at what rate does a single `Cycle`
document stop absorbing bets?**

Everything else about this platform scales by adding instances. The bet write
does not. Every bet takes a row lock on its bettor's wallet row
(`domains/markets/bet.routes.js`) and holds it across the debit, the bet insert
and the ledger rows, and `docs/governance/LATENCY.md` records that the height of
that ceiling is unmeasured. This directory measures it.

The ceiling this used to measure — a per-bet counter update on the one cycle row
every concurrent bettor shared — is **gone**: real pool totals are derived from
`bets` rather than stored, because a bet that updated the row it also holds
`FOR SHARE` deadlocks. So what remains to measure is *per-user* lock hold time
and how it aggregates, which is a genuinely different shape: distinct bettors no
longer queue behind each other.

> **This has not been run.** The harness is written and reviewed; no numbers
> exist yet, and the numbers it would have produced before the single-store
> migration would not transfer anyway — the contention point moved. Treat any
> statement about where the knee sits as unverified until you run it.

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
| 2 instances ≈ **2× throughput** | The app tier is the limit. The database is nowhere near saturated. | Nothing. Do **not** rewrite the bet path. |
| 2 instances ≈ **same throughput** | Database contention is the ceiling. | Look at *what* is contending before changing anything — see below. |

That comparison is the whole point. A one-instance number cannot distinguish
"one Node process is the limit" from "the database is the limit", and those have
opposite fixes — one is free, the other touches the money hot path.

**If the database is the ceiling, identify which contention it is before acting:**

- **Per-user wallet lock waits** — expected, and it scales with how concentrated
  your test accounts are. A run that drives 500 bets through 5 accounts measures
  the accounts, not the platform. Add accounts.
- **Connection pool waiting** — not contention at all; raise `PG_POOL_SIZE` or
  add PgBouncer.
- **Any 40P01 deadlock** — a **bug**, not a ceiling. It means something updates a
  row it also holds `FOR SHARE`. Do not tune around it; find the query.

## Why latency and not errors

A bet that loses a race for a row lock **waits** rather than failing — the lock
serialises it, the transaction commits late. So contention does not show up as
failed requests; it shows up as p99 latency past a threshold.

**A run with a 100% success rate can still be past the knee.** Plot p99
against achieved rate and look for where the curve bends.

## Confounders to rule out before believing a knee

Check these first, or you will "discover" a bottleneck that is really a
config setting:

1. **Rate limiting.** `bet` tier is 30/min per user (`RATE_LIMITS.md`). The
   script checks for 429s; if you see any, the limiter is your ceiling, not the
   database. Raise the tier or add accounts.
2. **Load shedding.** `middleware/loadShed.js` returns 503 past a configured
   in-flight ceiling. Watch `bb_requests_shed_total`.
3. **Connection pool.** Default 10 per instance. If p99 rises while
   `pg_stat_activity` shows sessions idle, you are queueing for a connection,
   not for a row lock.
4. **Argon2 on the login path.** Don't include logins in the run — ~80 ms each
   on a 4-thread libuv pool would dominate the measurement. The script uses
   pre-minted tokens for exactly this reason.

## Server-side signals worth capturing during the run

```sql
-- psql, against the staging database
SELECT wait_event_type, wait_event, count(*)         -- 'Lock'/'transactionid' climbing = real contention
  FROM pg_stat_activity WHERE state = 'active' GROUP BY 1, 2 ORDER BY 3 DESC;

SELECT deadlocks, xact_commit, xact_rollback         -- deadlocks must stay 0; any is a bug
  FROM pg_stat_database WHERE datname = current_database();
```

Plus the app's own `/metrics`: `http_request_duration_seconds`,
`bb_pg_pool_connections{state="waiting"}`, `bb_requests_shed_total`.

## Recording the result

When you have numbers, put them in `docs/governance/LATENCY.md` under
"horizontal scaling" and replace the "unmeasured" note. That file currently
says the ceiling is unknown; it should not keep saying that after a run.
