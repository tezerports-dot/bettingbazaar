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
| M-2 | `_mongoBetStake` moves balances with no idempotency key at all | **High** | **Resolved** — Postgres (`betPg.js`) + Mongo (ledger-first txn + required `Idempotency-Key`), 2026-08-19 |
| M-3 | `_mongoBetStake` swallows all ledger-write errors, including the duplicate-key that signals M-2 | Medium | **Resolved** — ledger and balance now commit in one transaction, so there is no swallowed-error window left |
| M-4 | `_mongoBetStake` moves money outside a transaction; ledger rows are best-effort | **High** | **Resolved** — Postgres (`betPg.js`) + Mongo (`session.withTransaction`, ledger-first), 2026-08-19 |
| M-5 | `atomicBet` is dead code with a non-functional idempotency key | Low | Documented |
| M-6 | `reserveAdminMint` combines `$expr` with `upsert`, which MongoDB refuses — admin token issuance threw on every call | **High** | **Fixed** |
| M-7 | A casino `ROLLBACK`/`REFUND` credits the player without proving a matching prior debit — a provider can mint real money | **High** | **FIXED in both paths** — the live Mongo endpoint and `casinoPg.js` |
| M-8 | `refundOrder` writes a provider-supplied round id into `WalletLedger.refId`, which is an ObjectId — every casino rollback/refund threw | **High** | **Fixed** |
| M-9 | `POST /v1/user/withdraw` created the PENDING request BEFORE reserving funds, so a failed reservation left an unfunded payable row an operator would pay by hand | **Critical** | **Resolved 2026-08-24 by REMOVAL** — the endpoint was one half of a second, unreachable withdrawal system (no client called it, no admin screen could approve it). Deleted rather than hardened; the live P2P path already reserves inside the order transaction |
| M-10 | `/auth/recover` revealed whether an Aadhaar had an account, and its rate limit was keyed on the caller-supplied `mobile` (in-process, per-worker) | Medium | **Fixed 2026-08-24** — one neutral response for every caller; IP-keyed, Redis-backed `accountRecoveryLimiter` |
| M-11 | The `AccountRecovery` model described a different flow than the route and both panels — every recovery submission failed validation, so locked-out players had no route back to their balance | **High** | **Fixed 2026-08-24** — model aligned to the live Aadhaar + video-KYC contract |

---

## M-8 — every casino rollback threw a CastError (FIXED)

`gameProvider.routes.js` calls `refundOrder(userId, amount, roundId, ...)` where
`roundId` is provider-supplied (`body.roundId || body.round_id || body.gameRound
|| txId`) — an arbitrary string. `refundOrder` stored it in
`WalletLedger.refId`, typed `ObjectId`, so any round id that is not 24-hex threw
a CastError **inside the transaction**. The refund aborted with it.

**No money was lost** — the transaction unwound the balance change too — but no
casino refund has ever succeeded. Same class as M-6: a path that has never
worked, found only by executing it. Found by the M-7 test, on its first run.

**Fix.** `refId` is set only when the id is a valid ObjectId. Nothing is lost by
dropping it: the id is already in `txId` (`refund_<orderId>`, which is also the
idempotency key) and in the reason text. Only the typed foreign-key column,
which cannot hold it, is skipped.

### The first fix was wrong, and how that was caught

Worth recording, because the failure mode is more interesting than the bug.

The first attempt rewrote `refId: orderId` to a shorthand `refId` at **all four**
`WalletLedger.create` call sites but declared the variable in `refundOrder`
alone. `creditDeposit`, `creditReserve` and `debitWinningsForWithdrawal` then
threw `ReferenceError: refId is not defined` inside their transactions — so a
fix for a broken casino refund broke **deposits, reserve allocations and
withdrawals**, the three paths that matter most.

Nothing local caught it. It is valid syntax, so `node --check` passed. The unit
suite passed, because those four functions had no unit test. The Postgres suite
passed, because it does not touch the Mongo path. Only the integration suite
caught it, and that suite needs a MongoDB replica set the build sandbox cannot
run — so it was visible only after a push, from CI.

Two things changed as a result:

- `asRefId()` is now a single shared helper at the top of the file instead of a
  local in one function. There is one definition to get right.
- `backend/tests/unit/walletLedgerWriters.test.js` exercises all four writers
  with a fake `mongoose`, asserting the ledger document each one builds. It
  needs no database, runs in milliseconds, and fails on exactly this mistake —
  verified by reintroducing it.

The general lesson is about `replace_all`: it is a fine way to apply an
identical edit and a bad way to apply one that depends on local scope.

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

## M-2 / M-4 — `_mongoBetStake`: no idempotency, no transaction
## (RESOLVED IN POSTGRES 2026-08-04; RESOLVED ON THE MONGO PATH 2026-08-19)

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

### Resolved in PostgreSQL, 2026-08-04 — `postgres/betPg.js`

The design above was taken, minus the fallback. `bets` + append-only
`bet_transitions`, with the bet row, its stake movement and its ledger rows in
**one transaction** under a single wallet lock (`walletPg.applyMovementWithin`,
extracted for exactly this).

- **M-2** — `bet_id` is UNIQUE and the collision happens inside the transaction,
  so a replayed request debits nothing further. The key must come from stable
  request identity; `middleware/idempotencyKey.js` is where a caller gets one.
  A fresh id per attempt is not idempotency, it is a new bet.
- **M-4** — impossible by construction. A settled bet with no ledger row behind
  it cannot be produced through this module; `findBetsMissingStakeMovement` is
  tested against a row inserted by raw SQL, because that is the only way to
  create the state at all.

### Resolved on the LIVE Mongo path too, 2026-08-19 — proposal (1)+(2) taken

The fallback was not needed after all: the launch runs on the Postgres money
authority, so `_mongoBetStake` is no longer the hot path, and the latency
objection that argued for shipping only proposal (1) no longer applies. Both
were taken.

- **`_mongoBetStake` is now ledger-first inside `session.withTransaction`**
  (`domains/wallet/walletAuthority.service.js`), the exact shape
  `releaseLockedStake` / `lockWithdrawal` already use in the same file. The
  per-slice `txId` UNIQUE index is the gate: a concurrent duplicate throws 11000
  on the ledger insert and aborts the whole transaction, so the `$inc` never runs
  twice (**M-2**, concurrent), and balance + ledger commit together or not at all
  (**M-4**). The old best-effort ledger write — and the
  `bb_unaudited_money_movements_total{path="bet_stake_*"}` counter that only
  METERED the window — are gone; there is no longer a window to meter. A cheap
  fast-path (ledger-row lookup) short-circuits the common *sequential* replay
  before it even opens a transaction.

- **The route now REQUIRES the `Idempotency-Key`** on `POST /bet/place`
  (`domains/markets/bet.routes.js`): `betTxBase = bet_<userId>_<key>` is the
  stake txId, and its derived deterministic ObjectId (`mongoIdFor`) is the Bet
  row `_id` on both stores — so the unique index, not the caller's discipline, is
  what makes a redelivery idempotent. A fast primary-key gate returns the
  original bet for a sequential retry; the money-mover — not the winner of the
  bet-row insert race — owns the pool increment and the Transaction row, so a
  concurrent duplicate can neither double-count the pool nor duplicate the log.
  The user-panel sends one key per tap and reuses it across its own 500/network
  retries. `tests/integration/betIdempotency.integration.test.js` proves the four
  deliveries (sequential retry, distinct key, missing key, concurrent burst) end
  to end.

The residual that remains Postgres-only: on Mongo the bet ROW is still a separate
insert from the stake transaction (two steps), so the "money locked against a
not-yet-written bet" window is narrowed (the deterministic `_id` lets a retry
heal it) but not closed by construction the way `betPg.placeBet` closes it in one
transaction. The launch path is Postgres, where it does not exist.

**The Mongo path is unchanged.** These defects are resolved *in the store that
will carry authority*, not patched in the one being migrated away from — the
latency risk the design note raises is a reason not to rewrite the hot Mongo
path, and it does not apply to the Postgres one, which already works this way
for every other domain.

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

## M-6 — `reserveAdminMint` threw on every call (FIXED 2026-08-04)

**Admin token issuance did not work at all.** `merchant.admin.routes.js` combined
an `$expr` cap guard with `upsert: true` in one `findOneAndUpdate`, and MongoDB
refuses that combination outright:

```
MongoServerError: $expr is not allowed in the query predicate for an upsert
```

Both call sites — `POST /admin/merchants/:merchantId/fund` and
`POST /admin/merchant-token-orders/:orderId/approve` — therefore returned 500 on
every attempt, and no merchant inventory could be issued through either.

### Why it survived

Nothing had ever executed this path against a real MongoDB. The routes had no
integration coverage, and static review reads the query as obviously correct —
the guard is in the filter, which is exactly where it should be. The defect is
not in the logic but in a MongoDB restriction that only appears at execution.

It was found by `backend/tests/integration/adminIssuance.integration.test.js`,
written for the Postgres migration of this domain: the first test that had ever
called the Mongo branch against a running server. **This is the clearest case in
the audit for the rule that nothing is marked PASS on code inspection.**

### The fix

The two statements are separated, because one of them needs the upsert and the
other cannot have it:

1. **the guarded increment** — `$expr` in the filter, no upsert. Still a single
   atomic compare-and-set, so two concurrent mints cannot both claim headroom
   only one of them has. That property was never the problem and is unchanged.
2. **an ordinary upsert** to create `SystemConfig{key:'main'}` when it does not
   exist — no `$expr`, so the upsert is legal. Runs only when step 1 matched
   nothing, tolerates a concurrent creator (duplicate key is the outcome it
   wanted), and step 1 is retried exactly once afterwards. A second miss is a
   real cap breach; retrying in a loop would turn a clean 400 into a hang.

`backend/tests/unit/adminIssuanceRouting.test.js` pins the invariant with no
database at all: no query may carry `$expr` and `upsert` together, and both
halves must still be present.

---

## M-7 — casino rollbacks are unbounded and unproven (RESOLVED IN POSTGRES)

`domains/casino/gameProvider.routes.js`

```js
} else if (type === 'ROLLBACK' || type === 'REFUND') {
  await refundOrder(userId, amount, roundId, 'depositBalance');
}
```

No check that the round was ever bet on. No bound on the amount. No comparison
against what the round actually took. A provider that is buggy, replayed, or
hostile can **credit a player real money** by posting a rollback for a round
that never had a bet — or a rollback larger than the bet it claims to reverse —
and nothing in this path can distinguish that from a legitimate reversal.

The `txId` duplicate check above it stops the *same* callback applying twice. It
does nothing about a *different* callback that should never have been honoured
at all, which is the actual exposure.

### Resolved in PostgreSQL, 2026-08-04 — `postgres/casinoPg.js`

A reversal must name a round with `debited_paise > 0`, and
`refunded_paise <= debited_paise` is a **CHECK constraint** — so the bound holds
against a future code path that forgets to test it. The `if` produces a clean
refusal; the constraint is what makes the rule a property of the *data* rather
than of one function.

The running totals move under the round's row lock inside the same transaction
as the wallet movement, so two concurrent rollbacks cannot both read "nothing
refunded yet". That case is tested with two *distinct* provider ids, where the
idempotency gate cannot help and only the lock can.

### And fixed on the LIVE Mongo path too — as M-2 and M-4 now are

M-2 and M-4 were, at the time this was written, left latent in Mongo because
`bet.routes.js` minted a fresh key per request, so the unsafe primitive was not
reachable in a way that lost money. That is no longer the state of the code: as
of 2026-08-19 the key is REQUIRED and the Mongo primitive is transactional and
idempotent (see "Resolved on the LIVE Mongo path too" above), so both are closed
on both stores rather than latent on one.

**M-7 was not latent either.** `POST /api/games/wallet` is a live endpoint any
configured provider can call, and the rollback branch had no guard at all.
Fixing it only in the store that is *not* authoritative — and will not be on
launch day — would have left the exploitable version running. The same
arithmetic now guards the Mongo handler: the reversal is refused unless the
round has a prior BET for that player, and refused again if the accumulated
refunds would exceed it.

The lookup is scoped by `userId` as well as `roundId`, because round ids are
provider-supplied and not guaranteed unique across players — without that, one
player's bet would authorise another player's refund.

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

---

## M-9 — a SECOND withdrawal system, unreachable and unfunded (REMOVED)

`domains/user/user.routes.js`, `POST /api/v1/user/withdraw` — deleted 2026-08-24.

The bug found first: the route created the `PENDING` `WithdrawalRequest` and
reserved the funds **afterwards**.

```js
const wr = await WithdrawalRequest.create({ …status: 'PENDING' });
await lockWithdrawal(String(req.user._id), amount, String(wr._id));  // ← can throw
```

Both stores throw when the balance cannot cover the reservation, and the outer
`catch` answered 500 — but nothing removed the request, so it survived as a
payable row with no money behind it. Since payouts are MANUAL, an operator would
wire real INR against it and discover the problem only when the approve click
failed. Both pre-checks were reads, so a player firing the five requests the rate
limit allows had one reserve and four become orphans.

### The finding underneath the finding

Hardening that ordering was the obvious fix, and it was the wrong one. Asking
which client calls the endpoint showed why:

- **No client calls it.** Every panel withdraws through the P2P path,
  `POST /api/p2p/withdrawal/create` → `fundingAuthority` → `PaymentOrder`.
- **No admin screen served its approve/reject routes.** A request created here
  locked the player's winnings into a record no operator could see, approve or
  reject — the money simply stopped existing for them. The orphan bug was the
  smaller of the two problems.
- **It duplicated the P2P escrow down to the wallet primitive.**
  `lockWithdrawal` and `debitWinningsForWithdrawal` perform the identical
  movement (winnings → locked, one ledger row); they differ only in txId prefix.

So this was not one endpoint with a bug. It was a second, parallel withdrawal
implementation that had drifted out of use while remaining mounted and reachable
by anyone holding a valid player token. It was removed entire: the two user
routes, the three admin routes, and the `WithdrawalRequest` model.

**The live path was already correct.** `paymentProcessing.createWithdrawalOrder`
debits escrow and saves the order inside ONE transaction, so a failed debit means
no order — the invariant the deleted route violated. It also carries
`requireApprovedKyc`, which the deleted route did not.

`lockWithdrawal` survives with no production caller, kept only because three
integration suites use it to set up a locked balance for the release/refund
tests. It is documented at its definition as not-for-new-work, pointing at
`debitWinningsForWithdrawal`. Retiring it means repointing those suites, which
belongs in its own change with CI to prove it.

**The general lesson**, and the reason this entry is longer than the bug
deserved: two implementations of one money path do not merely duplicate effort —
they route review attention to whichever one a reader finds first. The audit that
produced M-9 hardened the dead one and would have shipped that as a fix.

## M-10 / M-11 — account recovery: an Aadhaar oracle on a flow that never ran (FIXED)

`routes/account-recovery.routes.js`, `models/accountRecovery.model.js`

**M-10.** `/auth/recover` answered "No account found with this Aadhaar" when the
lookup missed and proceeded when it hit — an oracle for *does this person gamble
here*, which is sensitive on its own and is the kind of profiling India's DPDP
Act exists to prevent. Its rate limit made the oracle practical rather than
theoretical: an in-process `Map` keyed on the **`mobile` value from the request
body**, so a caller varying that field chose their own budget, the counters were
invisible to the other PM2 workers, and a restart cleared them.

Now: one `neutral` response object returned on every path — matched, unmatched,
duplicate — and the shared, IP-keyed, Redis-backed `accountRecoveryLimiter`. An
unmatched submission is still recorded with `userId` unset, so someone who
mistyped their Aadhaar reaches a human instead of vanishing into a silent
success; the operator, not the endpoint, distinguishes the cases.

**M-11**, found while fixing M-10: the `AccountRecovery` model described a
PAN-based flow (`requestId`, `panHash`, `panLast4` all required, uppercase
`PENDING_VIDEO`/`UNDER_REVIEW` statuses) while the route and BOTH panels speak an
Aadhaar + video-KYC contract (`recoveryId`, `fullName`, `dob`, `videoKycUrl`,
lowercase statuses). Nothing reconciled them, so every submission failed schema
validation and returned 500, the status lookup queried a field that did not
exist, and an approval could not save. **Account recovery — the only route back
to their balance for a locked-out player — did not work at all.**

The route and the panels agree with each other, so the model moved. Fields are
optional unless the flow genuinely cannot proceed without them, so a partially
filled request stays reviewable by a human rather than rejected by the database.
