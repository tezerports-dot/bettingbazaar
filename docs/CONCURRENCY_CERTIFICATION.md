# Concurrency & money correctness certification

The scenarios that ordinary unit and integration tests miss, because those run
one call at a time and money bugs live in the interleavings.

**Status: PARTIALLY CERTIFIED.** Five scenarios are now covered by automated
tests. Four need infrastructure this environment does not have and are specified
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
| 6 | 100–1000 simultaneous bets, multi-instance | **NOT VERIFIED** | staging — §A |
| 7 | Process crash between debit and ledger write | **NOT VERIFIED** | staging — §B |
| 8 | Database failover during settlement | **NOT VERIFIED** | staging — §C |
| 9 | WebSocket/SSE reconnect during settlement | **NOT VERIFIED** | staging — §D |

### Why 1–5 are covered but 6 is not

The automated tests fire concurrent calls **inside one Node process against one
MongoDB**. That genuinely exercises MongoDB's transaction conflict handling —
which is where the double-charge risk lives — so it is not a simulation.

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

**Setup.** ≥2 app instances behind the load balancer, sharing one MongoDB and
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
MongoDB `writeConflicts`, transaction abort rate, p99 bet-placement latency.

**Expected first ceiling:** write conflicts on the hot wallet documents. Rising
abort rates with latency still acceptable is normal — MongoDB retries. Aborts
climbing while throughput falls means you have found the limit.

## §B — Crash between debit and ledger write

This is the failure mode `_mongoBetStake` is exposed to by design (M-2/M-4 in
`MONGO_MONEY_AUDIT.md`): balance and ledger are separate operations there, so a
crash in between leaves money moved and unaudited.

**Run.** Under steady bet load, `kill -9` one app instance. Repeat ~10 times to
hit the window.

**Then reconcile.** `npm run reconcile:pg`, and check
`bb_unaudited_money_movements_total`.

**Expected.** `debitForBet` (transactional) survives cleanly — the transaction
either committed or did not. `_mongoBetStake` may show unaudited movements; each
one is a balance the ledger cannot explain. **Count them.** A non-zero count is
the empirical argument for doing the M-2/M-4 work before real money, and if it
is zero across ten crashes that is real evidence the window is narrow.

## §C — Database failover during settlement

**Run.** Trigger a MongoDB primary step-down mid-settlement:
`rs.stepDown()` on the primary while a cycle settles.

**Expected.** Transactions in flight abort with a retryable error; the driver
reconnects to the new primary. Settlement should resume or fail cleanly, never
half-apply.

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
