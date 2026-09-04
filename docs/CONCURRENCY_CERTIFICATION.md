# Concurrency & money correctness certification

The scenarios that ordinary unit and integration tests miss, because those run
one call at a time and money bugs live in the interleavings.

**Status: PARTIALLY CERTIFIED.** Eight scenarios are covered — six by automated
tests against real databases, two by adversarial runs against live services
(§E). Five need infrastructure this environment does not have and are specified
below as a staging runbook rather than claimed.

---

## Scenario matrix

| # | Scenario | Status | Where |
|---|---|---|---|
| 1 | 50 copies of one bet arrive at once (retry storm) | **COVERED** | `moneyConcurrency.integration.test.js` |
| 2 | 100 distinct bets race a balance that fits 10 | **COVERED** | same |
| 3 | Duplicate webhook delivery (×20) | **COVERED** | same |
| 4 | Deposits/wins interleaved with betting | **COVERED** | same |
| 5 | Racing writes on one idempotency key | **COVERED** | same |
| 6 | Merchant token wallet under concurrency (user↔merchant, admin↔merchant) | **COVERED** | `npm run test:pg` |
| 7 | Postgres killed mid-transaction | **COVERED** | adversarial run — see §E |
| 8 | Redis killed under a live server | **COVERED** | adversarial run — see §E |
| 9 | 100–1000 simultaneous bets, multi-instance | **NOT VERIFIED** | staging — §A |
| 10 | Process crash between debit and ledger write | **COVERED — structurally** | the debit and its ledger rows are one transaction; see §B |
| 11 | Database failover during settlement | **NOT VERIFIED** | staging — §C |
| 12 | WebSocket/SSE reconnect during settlement | **NOT VERIFIED** | staging — §D |
| 13 | Application instance / load balancer restart | **NOT VERIFIED** | staging — §F |

### Why single-process coverage is real, but not the production shape

The automated tests fire concurrent calls **inside one Node process against one
real PostgreSQL**. That genuinely exercises row locking, the negative-balance
guard and the unique-`tx_id` gate — which is where the double-charge risk lives —
so it is not a simulation.

What it does **not** exercise is contention across **multiple app instances**,
which is the production shape. The invariants are the same, but the retry
pressure and lock-wait behaviour are not, and connection-pool exhaustion cannot
appear at all with one process. That is a staging measurement, not a test.

### The invariants every scenario asserts

Assertions are on invariants, never on which racer wins — that is
non-deterministic, and asserting it produces flaky tests that teach nothing.

1. **Money is never created** — total debited ≤ total available.
2. **Money is never destroyed** — a refused debit leaves the balance untouched.
3. **No negative balances**, in any pocket.
4. **Exactly-once charging** — a replayed movement charges once, however many
   copies arrive.
5. **The ledger explains the balance** — `start + credits − debits` equals the
   final balance exactly.

Invariant 5 is the one that catches the subtle failures. A double-charge can
look plausible in isolation; a balance the ledger cannot account for cannot.

---

## §A — Multi-instance bet contention (staging)

**Setup.** ≥2 app instances behind the load balancer, sharing one PostgreSQL and
one Redis.

**Run.** `loadtest/bet-contention.js` (k6), stepping 100 → 500 → 1000 virtual
users, all betting against a **small pool of wallets** — contention is the point,
so do not spread load across thousands of users or nothing will collide.

```bash
npm run loadtest:seed
k6 run --vus 1000 --duration 5m loadtest/bet-contention.js
```

**Assert afterwards** (not during — read the end state):

```js
// For every wallet touched: the ledger must explain the balance.
balance === startingBalance + sum(credits) - sum(debits)
// And no pocket below zero.
```

**Watch during:** `bb_unaudited_money_movements_total` (must stay 0),
`pg_stat_database.deadlocks`, lock-wait time on `wallets`, transaction rollback rate, p99 bet-placement latency.

**Expected first ceiling:** lock waits on the hot `wallets` rows. Queueing on a
row lock with latency still acceptable is normal — that is the lock doing its
job. Waits climbing while throughput falls means you have found the limit. **Any
40P01 deadlock is a bug, not a ceiling** — it means something updates a row it
also holds `FOR SHARE`.

## §B — Crash between debit and ledger write

**This failure mode has been designed out, and the scenario is now a regression
check rather than a measurement.** It used to be real: one code path moved the
balance and wrote its ledger rows as *separate* operations, so a crash in between
left money moved and unaudited. That path is gone. The debit, the bet row and the
ledger rows are written in **one transaction** — they commit together or not at
all — so there is no window in which a balance can exist that the ledger cannot
explain.

**Run it anyway.** Under steady bet load, `kill -9` one app instance. Repeat ~10
times to hit whatever window you believe remains.

**Expected.** Zero unaudited movements, every time. A transaction either
committed or it did not. **A non-zero count is a P1 bug**, not a tolerable
window — it would mean something writes a balance outside the transaction that
writes its ledger, which §7 of `04-GOVERNANCE.md` forbids.

**Counters must be reconstructed from rows, not accumulated** while you measure:
an accumulator counts passes, not rows, and the crash you are inducing is exactly
what loses its count while the money stays correct.

## §C — Database failover during settlement

**Run.** Trigger a PostgreSQL failover mid-settlement: promote the standby
(`pg_ctl promote`) while a cycle settles, or restart the primary under load.

**Expected.** Transactions in flight abort with a connection error; the pool
reconnects. Settlement should resume or fail cleanly, never half-apply — it is
crash-resumable and idempotent per `tx_id`, so a retry re-runs the same pass
without paying twice. **Check afterwards that the cycle still has its winner and
that no cycle sits past its declaration time without one** — a cycle with no
winner is never offered for settlement, so that state stalls silently.

**Assert.** Every bet in that cycle ends `WON`, `LOST` or `PENDING` — never a
winner without a payout, and never a payout without a `win_<betId>` ledger row.
Run the trial-balance check afterwards.

**Also test Postgres failover** once the wallet cutover is done; until then
Postgres is a mirror and a failover there costs mirror lag, not money.

## §D — Realtime reconnect during settlement

**The concern:** a reconnecting client replaying settlement events causing a
duplicate credit.

**Why it should not happen:** credits are keyed `win_<betId>` and the unique
index is the gate, so a duplicated *event* cannot produce a duplicated *credit*.
Scenario 5 above proves the gate holds under a race.

**Still test it,** because the risk is not the ledger — it is the UI. Drop and
restore WebSocket/SSE connections for a subset of users mid-settlement and
confirm the balance the client displays converges on the server's. A client
showing a phantom balance generates support tickets and looks exactly like a
money bug to the person seeing it.

---

## Exit criteria

Do not take real-money traffic until:

- [ ] §A run at 1000 VUs with the ledger explaining every balance
- [ ] §A shows `bb_unaudited_money_movements_total` at 0
- [ ] §B run ≥10 times, unaudited movements counted and accepted or fixed
- [ ] §C run at least once, no half-applied settlement
- [ ] §D run, client balances converge
- [ ] Trial balance clean after every one of the above

## Known gap this cannot close

All of the above tests the system as built. None of it tests **M-2**: the main
bet path has no idempotency key on the balance move. Today's caller generates a
fresh UUID per request, so a retry creates a second bet rather than
double-charging one — meaning §A will pass and the underlying weakness will not
show. It is a latent trap for the next caller, not a bug the load test can
surface. Fix it, or record the decision not to; do not let a green §A read as
evidence it is safe.


---

## §E — Infrastructure restarts already exercised (results)

Run against the real services available in the audit environment. These are
results, not plans.

### Postgres killed mid-transaction — **found and fixed a crash**

`pg_ctl -m immediate stop` during 60 concurrent debits. Before the fix the whole
Node process died on an unhandled `'error'` from a checked-out client:

    Emitted 'error' event on Client instance at:
        at Client._handleErrorEvent (pg/lib/client.js:417:10)

Since Postgres is currently only the dual-write MIRROR, a restart of a database
the money path does not read from was taking down every app instance. Fixed with
`connectGuarded()`. After:

    committed=7  rejected=53   (process survived)
    balance=93000  ledgerDebits=7000  →  93000+7000 == 100000   HOLDS

**No lost money, no duplicated settlement, 53 in-flight operations surfaced as
errors rather than false successes.**

### Redis killed under a live server — **survives**

`redis-cli shutdown nosave` against a running server, then restart.

    before   /health 503 (no database in sandbox)    /health/live 200
    killed   /health 503                             /health/live 200   process ALIVE
    restart  /health 503                             process ALIVE
    60 Redis error lines logged, no crash

Two properties confirmed by reading the code this exercised:

- **Rate limiting degrades, it does not fail open.** `redisRateLimitStore.js`
  falls back to per-instance in-memory counting on a Redis error
  (`enableOfflineQueue:false` makes it fail fast rather than hang). With N app
  instances an attacker gets N× the limit during an outage — a real but bounded
  degradation, and far better than unlimited login attempts.
- **Redis state does not affect readiness.** `readinessState()` reports Redis but
  `ready` depends only on PostgreSQL. So a Redis outage keeps the instance in the load
  balancer. That is defensible (bets still work) but it is a *choice*; if
  realtime and rate limiting matter more than availability, readiness should
  include Redis.

### Not exercisable here

Database restart under load, app-instance restart and load balancer failover
(single process, no LB), and network partition (no second host). §B, §C, §D and §F below remain the staging runbook.

## §F — Application instance and load balancer restart (staging)

**Run.** Under steady bet load with ≥2 instances behind the Hetzner LB:
restart one instance (`docker restart`), then drain one backend from the LB.

**Expected.** The graceful shutdown fails readiness first, waits for the LB to
notice, then closes — so in-flight requests finish. Watch for 502s: any means
the drain window is shorter than the LB's health-check interval.

**Assert.** Ledger explains every balance afterwards; no bet in a state without
its money movement; `bb_unaudited_money_movements_total` still 0.
