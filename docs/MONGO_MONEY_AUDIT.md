# MongoDB money-path audit

MongoDB is the authoritative money store today. This audits its mutations to the
depth `postgres/walletPg.js` received, and does **not** assume correctness
because it is the incumbent.

**Verification limit, stated up front:** the audit sandbox cannot run MongoDB —
the `mongod` download is blocked by the proxy (`fastdl.mongodb.org` returns 403
through the egress tunnel), and `apt` has no `mongodb-org-server` package. So
findings below are **static analysis**, and the regression tests written for
them are verified **by CI**, which has real service containers. Nothing here is
marked PASS on the strength of reading alone.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| M-1 | `debitForBet` double-charges when a replay recomputes a different pocket split | **High** | **Fixed** |
| M-2 | `_mongoBetStake` moves balances with no idempotency key at all | **High** | **Documented, not fixed** — see proposed design |
| M-3 | `_mongoBetStake` swallows all ledger-write errors, including the duplicate-key that signals M-2 | Medium | **Partly fixed** — now metered and logged |
| M-4 | `_mongoBetStake` moves money outside a transaction; ledger rows are best-effort | **High** | **Documented, not fixed** — see proposed design |
| M-5 | `atomicBet` is dead code with a non-functional idempotency key | Low | Documented |

---

## M-1 — `debitForBet` double-charge on a re-split replay (FIXED)

`domains/wallet/wallet.service.js`

The function writes one ledger row per pocket it actually draws from —
`<base>_dep`, `<base>_win` — and **no row for a pocket it did not touch**. The
unique `txId` index is the durable idempotency gate, but it can only fire when
the replay writes a key that already exists.

The split is recomputed from balances **as they are at replay time**, so a
deposit landing between attempts moves the whole charge into a different pocket:

```
original: deposit 0,   winnings 100 → bet 50 writes <base>_win only
…a deposit of 100 lands…
replay:   deposit 100, winnings 50  → bet 50 writes <base>_dep only
```

No key repeats. The unique index never fires, the transaction commits, and the
user is charged twice for one bet. The pre-read did not catch it either — it
checked only `<base>_dep` and the bare key, and neither existed.

This is the exact hazard `postgres/walletPg.js` documents on
`debitSpendOrderPaise`, which solves it with an under-lock probe over every
pocket key. Mongo had the hazard and checked one suffix.

**Reachability.** Needs the same `txId` submitted twice with a balance change in
between. `txId` for a bet is `bet_<user>_<cycle>_<bet>` — stable across retries,
so an internal retry, a settlement pass racing the payout recovery task (the
scenario the code's own comments cite), or a client double-submit all qualify. A
concurrent deposit is ordinary traffic on a betting platform.

**Fix.** The probe now covers every candidate key and runs **inside** the
transaction, where it is durable against an attempt that already committed.
Concurrent attempts still serialise on the `User` document write conflict, after
which `withTransaction` re-runs the callback and the probe sees the winner's row.

**Tests.** `backend/tests/integration/debitForBetReplay.integration.test.js` —
both split directions, a guard against over-correction (a genuinely different
bet with a similar key must still charge), and the unchanged-split replay.
Verified by CI.

---

## M-2 / M-4 — `_mongoBetStake`: no idempotency, no transaction (NOT FIXED)

`domains/wallet/walletAuthority.service.js`

This is the **main bet path** — `lockBetStake` / `unlockBetStake`, called on
every bet placement from `domains/markets/bet.routes.js`. It is the highest
-traffic money mutation in the system.

```js
const before  = await User.findById(userId).lean();
const updated = await User.findOneAndUpdate(filter, { $inc: inc }, { new: true });
if (!updated) return { ok: false, insufficient: true, txId };
// …ledger rows written afterwards, best-effort…
```

**What is right:** the `$gte` filters make the debit atomic. A concurrent bet
landing between the caller's split and this write makes the filter match no
document, and the caller is told to retry. Negative balances are prevented.

**M-2 — nothing keys off `txId`.** The balance movement is a bare `$inc`. Call
`lockBetStake` twice with the same `txId` and the balance is debited **twice**.
The ledger rows would collide on the unique index — but see M-3, that error was
discarded. Unlike M-1, there is no gate here at all, durable or otherwise.

*Current exposure is narrow:* `bet.routes.js` builds
`betTxBase = bet_<userId>_<randomUUID()>` fresh per request, so a client retry
produces a *different* key and creates a second bet rather than double-charging
one. The primitive is unsafe, not the current call site — which makes it a
latent trap for the next caller, and for any retry added inside the request.

**M-4 — balance and ledger are two operations, not one.** The ledger write is
explicitly best-effort so a failure cannot strand a bet that already moved
money. That tradeoff is defensible. Its consequence is that **money can move
unaudited**, and the ledger is exactly what reconciliation and
`bb_pg_trial_balance_ok` are computed from — so the failure erases its own
symptom.

### Proposed design (needs a decision, not a patch)

Per the instruction to stop and document rather than rewrite the hot money path:

1. **Make the movement idempotent on `txId`.** Write the ledger rows *first*,
   inside a transaction, and let the unique index reject the replay before the
   `$inc` runs. This inverts the current order and makes the index the gate, as
   it already is in `debitForBet`.
2. **Put both in one `session.withTransaction`.** A replica set is already
   mandatory (31 transaction sites), so this costs no new infrastructure. It
   removes the unaudited-movement window entirely and matches the Postgres path,
   which is the eventual authority — converging the two now means the cutover
   changes fewer variables.
3. **Keep the `$gte` filters.** They remain the negative-balance guard inside
   the transaction.

**Risks to weigh:** transactions add latency and retry churn on the hottest
path, and bet placement is spiky by nature (everyone bets at cycle close).
Measure on Railway staging under `loadtest/bet-contention.js` before committing.
If the latency proves unacceptable, the fallback is (1) alone — idempotency
without full atomicity — which fixes the double-charge but leaves M-4 open.

**Do not ship the cutover assuming this is equivalent to the Postgres path.**
It is not: `walletPg.applyMovementPaise` puts balance and ledger in one
transaction under a row lock. This does neither.

---

## M-3 — swallowed ledger errors (PARTLY FIXED)

The ledger write was `insertMany(...).catch(() => {})` inside a `try {} catch {}`
— two layers discarding every error, including:

- the duplicate-key error that is the **only** signature of an M-2 double-debit;
- any write failure, which is the **only** evidence of an M-4 unaudited movement.

Now increments `bb_unaudited_money_movements_total{path}` and logs the user,
`txId`, direction and error code. The tradeoff is unchanged — money still stands
— but the blind spot is now observable.

**Alert on this.** Any non-zero value means the ledger no longer explains the
balances:

```
increase(bb_unaudited_money_movements_total[15m]) > 0
```

---

## M-5 — `atomicBet` is dead code (documented)

`wallet.service.js` still exports `atomicBet`, and `bet.routes.js:6` records that
it was removed from use ("never called; inline atomic pattern used instead").

Its idempotency key is `bet_<userId>_<cycleId>_<Date.now()>` — a fresh value on
every call, so its `checkIdempotent` can never match and the check is
decorative. Harmless while unused; a trap if someone wires it up. Recommend
deleting it, which is a call for whoever owns that module.

---

## Paths reviewed and not found defective

Static review only — none of these were executed here.

| Path | Note |
|---|---|
| `debitWinningsForWithdrawal` | Single ledger row, stable key `wd_<orderId>`; unique index is a real gate. Correctly refuses to touch `depositBalance`. |
| `creditWinnings` | Single row, caller-supplied key. No split, so the M-1 hazard cannot arise. |
| `creditDeposit`, `creditReserve`, `refundOrder` | Single row, order-derived keys. |
| `settleWins` | One transaction, per-bet key `win_<betId>`. |
| `adminAdjust` | Wrapped in `session.withTransaction()`. |
| Negative-balance prevention | `$gte` filters and explicit balance checks throughout. |
| `round2` float arithmetic | Rupee floats on the Mongo side; integer paise only past the Postgres boundary. Not a defect today, but it is why the Postgres cutover matters. |

## Not covered by this audit

Still **NOT VERIFIED** — listed so the gaps stay visible:

- Merchant wallet, payouts, treasury, equalization, disputes
- Bonus, commission, and referral paths
- Deposit and withdrawal order state machines end to end
- Concurrent double-spend under real load (`loadtest/bet-contention.js` has
  never been run)
- Money conservation across a full settlement cycle
