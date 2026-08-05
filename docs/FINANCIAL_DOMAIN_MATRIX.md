# Financial domain matrix

Every path that moves money, what exists for it in PostgreSQL today, and whether
it may carry authority.

**Generated from the registry, not from intent.** The source of truth is
`CAPABILITIES` in `backend/postgres/moneyAuthority.js`. To see it live:

```bash
node -e "import('./backend/postgres/moneyAuthority.js').then(m => \
  console.table(m.authorityMatrix()))"
```

---

## `POSTGRES_FULL_FINANCIAL_AUTHORITY = NOT READY`

11 declared paths. **4 implemented, 7 not started.** 0 currently on Postgres.

`wallet`, `merchant_wallet`, `merchant_settlement` and `admin_issuance` are all
cutover-ELIGIBLE. None is flipped, and two of them additionally wait on the
ordering gate: `merchant_settlement` needs `orders`, and `admin_issuance` needs
`merchant_wallet` actually flipped rather than merely eligible.

The 11th, `casino_settlement`, was added 2026-08-03: casino provider callbacks
credit and debit real balances (`gameProvider.routes.js` calls
`debitForGameProviderBet`, `creditWinnings`, `refundOrder`) and no path described
them, so the matrix showed ten domains while eleven moved money.

## The matrix

Listed in the order the plan flips them.

| Path | Impl | Dual-write | Reconciled | Rollback | Eligible | Authority |
|---|:--:|:--:|:--:|:--:|:--:|---|
| `wallet` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `merchant_wallet` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `ledger` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `orders` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `kyc` | ❌ | ✅ | ❌ | ✅ | no | mongo |
| `merchant_settlement` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `admin_issuance` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `bets` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `settlements` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `casino_settlement` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `bonuses_and_commissions` | ❌ | ❌ | ❌ | ❌ | no | mongo |

No eligible path has been flipped. Eligibility means only that the flip is
*permitted*; `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` covers what is still
required before it should happen — every one of the four is now blocked on
`infrastructureTested` alone.

> This table is maintained by hand and has drifted before. The generated one in
> `PRODUCTION_CERTIFICATION_CHECKLIST.md` is the one to trust when they
> disagree; the command at the top of this file prints the registry live.

## What each column means

- **Impl** — a real Postgres reader *and* writer exist, and production call
  sites route through `isPostgresAuthoritative()`. This is the column that was
  missing: `ledger`, `orders` and `kyc` had mirrors and reconciliation, so they
  *looked* ready, but nothing read Postgres and no call site consulted the
  resolver.
- **Concurrency and infrastructure testing** are tracked separately, in
  `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md`. Being eligible to carry authority
  is not the same as having been proven under load or under failure, and merging
  the two would let a green cutover gate imply a certification nobody performed.
- **Dual-write** — Mongo writes are mirrored to Postgres, so a cutover would
  find data there.
- **Reconciled** — a pass compares the stores and can prove they agree.
- **Rollback** — a reverse mirror keeps Mongo current after a flip.
- **Eligible** — all four. Enforced in code: `authorityFor()` returns `mongo`
  for an ineligible path however the environment is set, and a production boot
  **refuses to start**.

## Per-path detail

### `wallet` — the only complete path
`postgres/walletPg.js` + `walletPgAuthority.js`. Row-locked, negative-balance
guard in the `UPDATE … WHERE`, ledger in the same transaction, unique `tx_id`
idempotency. 51 tests against real PostgreSQL 16, plus adversarial concurrency
(200 racing debits, retry storms) and a crash-recovery run.

Eligible, but **not flipped** — see `PRODUCTION_ARCHITECTURE.md` for why the
reconciliation gate should hold until after launch.

### `ledger`, `orders`, `kyc` — mirrored, not implemented
`dualWrite.js` writes `accounting_events`, `payment_orders`, `utr_registry` and
`user_kyc`. There is no Postgres reader for any of them, and no call site asks
the authority resolver. Setting their env var previously changed nothing while
the config claimed otherwise; it is now a boot failure.

### `merchant_wallet` — ✅ complete, eligible, not flipped
`postgres/merchantWalletPg.js`: `merchant_wallets` (available / reserved /
settlement pockets, integer paise) + `merchant_wallet_entries` (append-only,
arithmetic CHECK, UNIQUE `tx_id`). One transaction per movement, row locked with
`SELECT … FOR UPDATE`, guard in the `UPDATE`'s `WHERE`, entry written in the same
transaction. `postgres/merchantWalletPgAuthority.js` is the Mongo-shaped adapter,
and `merchantWallet.service.js` routes to it through the resolver.

**101 PostgreSQL tests green** across the suite, of which 50 cover this domain:
200 racing reservations against a balance that fits 100 (exactly 100 commit), 200
racing debits through the authority path, a 200-copy retry storm on one key
(applied once), append-only enforcement, and reconciliation drift of zero.

Four things had to be true before the flags moved, and each was built separately:

1. **Routing** — `merchantWallet.service.js` consults
   `isPostgresAuthoritative(MERCHANT_WALLET)` on both mutators.
2. **Balance mirror** — `mirrorMerchantBalance()`. Only the ledger was mirrored
   before, so `merchant_wallets` stayed empty while `merchant_wallet_ledger`
   filled and a cutover would have started reading balances of zero.
3. **Reconciliation** — `reconcileMerchantBalances()` compares the *number* in
   both stores (row-presence reconciliation is structurally blind to a balance
   that differs while both rows exist), and `reconcileMerchantLedgers()` checks
   that the Postgres ledger explains the Postgres balance. Both run in the
   5-minute pass and publish `bb_balance_drift_paise`.
4. **Rollback** — `reverseMirrorMerchantMovement()` copies ledger rows *and*
   balance back to Mongo after every committed movement. The ledger rows are the
   load-bearing half: Mongo's idempotency gate is
   `MerchantWalletLedger.findOne({ txId })`, so without them a fallback would not
   recognise a movement Postgres made and the next retry would apply it twice.

Three properties worth knowing before flipping it:

- **Reads still come from Mongo.** Display, scoring and assignment eligibility
  all read the live-mirrored `Merchant.tokenBalance`. The authoritative
  sufficiency check is the debit itself, which refuses transactionally, so a
  stale read can misroute an order but cannot move money wrongly.
- **The opening balance must be posted first.** A mirrored balance has no
  Postgres entries behind it, so the ledger cannot explain it. Run
  `npm run reconcile:pg -- --open-merchant-ledgers` before the flip; it is
  idempotent and refuses to launder a balance that moved without an entry.
- **`reserved` and `settlement` are structurally zero** until
  `merchant_settlement` lands. That domain must revisit the single-`tokenBalance`
  projection, because Mongo cannot represent a per-pocket movement — the reverse
  mirror refuses one rather than write keys Mongo's gate cannot match.

The Mongo original's reserve→complete shape was carried across but expressed
properly: its reservation was a ledger row with a null `balanceAfter` that a
crash could strand; here a reservation is a real balance movement inside one
transaction, so it cannot be half-done.

### `casino_settlement` — Mongo-only, and it bypasses the bets path
Provider callbacks (BET/WIN/ROLLBACK/REFUND/CANCEL) call `walletAuthority`
directly rather than the bet engine, so this path depends on `wallet` and
`ledger`, not on `bets`. A ROLLBACK or REFUND credit does not currently have to
prove a matching prior debit; the Postgres design must require it.

### `bets` — Mongo-only, with two known defects to fix in the port
`_mongoBetStake` has **no idempotency key** on the balance move (M-2) and writes
its ledger **outside** the transaction (M-4). Both are recorded in
`MONGO_MONEY_AUDIT.md`. The Postgres design must resolve them rather than carry
them across: a bet needs an idempotency key derived from stable request
identity, not a fresh UUID per attempt — a new UUID on every retry is not
idempotency, it is a new bet.

### `merchant_settlement` — three of four, blocked on ONE thing
`postgres/merchantSettlementPg.js`: `merchant_settlements` +
`merchant_settlement_transitions`, a state machine the database enforces —
expected-previous-state guards in the `UPDATE`'s `WHERE`, the transition and its
pocket movement composed into **one transaction** under a single merchant lock,
two UNIQUE idempotency gates (one for the money, one for the state), append-only
history. 24 tests: a 200-way reservation race, 200-copy retry storms on open and
on transition, a racing complete-vs-cancel where exactly one wins, an interleaved
storm of every transition type, and a backend killed mid-transition.

Mirrored (`mirrorMerchantSettlement`), reconciled cross-store
(`reconcileMerchantSettlementStates`) and rollback-capable
(`reverseMirrorMerchantSettlement`). `withdrawalHold.service.js` and
`merchant.routes.js` route through the resolver.

**The state inversion is DONE** (2026-08-04). `settleHold` used to flip
`PaymentOrder.merchantCreditStatus` out of `HELD` *before* completing the
Postgres settlement, because that `findOneAndUpdate` was also its concurrency
gate — which inverted authority on the Postgres path (Mongo decided, the source
of truth followed) and recreated the original stranding window somewhere new.

Now the settlement's own `RESERVED→SETTLED` guard is the gate and Mongo is
written afterwards as a mirror. Three consequences, each of which is where the
new tests point:

- **A failed player-side release must be compensated, not sequenced away.** The
  gate has to come first, so `releaseWithdrawal` can now fail *after* the
  merchant has been credited. `SETTLED→REVERSED` takes it back as a recorded
  movement — entries, a history row, and permission to drive the merchant
  negative because the tokens may already have been spent. The alert says
  whether the compensation landed, because "merchant credited for a stake the
  player still holds" is the one genuinely unsafe state left and it must not be
  folded into a generic failure.
- **`reverseHold` moved with it, deliberately together.** Leaving the dispute
  path on Mongo's gate while the sweep moved to Postgres would be worse than
  moving neither: the two outcomes of one race would then be decided by two
  different databases, and a dispute and a sweep could each believe they won.
- **A lagging mirror is now self-healing.** Re-mirroring is exactly what removes
  an order from the sweeper's queue, so the repair happens on the next pass
  rather than needing the reconciler.

Mongo's status is still read, for **one** question: may a settlement be *opened*?
That is what stops a stray sweep manufacturing a liability against an order
completed long ago under the Mongo path. Once a settlement row exists its own
state machine decides and Mongo's opinion is ignored — which is what stops a
lagging mirror stranding a settlement Postgres is holding at `RESERVED`.

Also closed here: the settlement domain composes `applyMovementWithin` directly
rather than going through `merchantWalletPgAuthority`, so it never inherited that
module's reverse mirror. Until now a settlement moved a merchant's tokens in
Postgres and left `Merchant.tokenBalance` and the whole `MerchantWalletLedger`
untouched — losing the movement on a fallback, and (worse) leaving Mongo's
`findOne({ txId })` idempotency gate unable to recognise it, so the first retry
after a fallback would apply it a second time.

**Still not `implemented: true`**, for a narrower reason than before: the suite
that proves the two stores *agree*
(`tests/integration/withdrawalHoldPgAuthority.integration.test.js`) needs a
MongoDB replica set this environment cannot run, so only CI has ever executed it.
Flipping on the strength of the two suites that do run here would be marking a
pass on code inspection of the third.

What this domain does add that Mongo cannot express: a withdrawal's owed tokens
now sit in a pocket the merchant cannot spend. On Mongo they simply do not exist
during the hold window, so nothing records the liability at all.

### `admin_issuance` — ✅ complete, eligible, not flipped
`postgres/treasuryPg.js` (double entry across eight accounts) plus
`postgres/adminIssuanceAuthority.js`, the routed adapter.
`merchant.admin.routes.js` consults the resolver on both call sites.

It exists to FIX three defects rather than port them:

1. **No idempotency key.** `reserveAdminMint(amount)` took an amount and nothing
   else, so two deliveries of one admin request minted twice and nothing could
   tell that from two legitimate top-ups. Every mint now carries a
   caller-supplied `movementId` that collides inside the transaction.
2. **A rollback that erased.** `$inc: { minted: -amount }` under
   `.catch(() => {})` — a retried rollback invented headroom under the cap, and
   a swallowed failure left the supply permanently wrong. A rollback is now a
   BURN: its own key, its own entries, idempotent, and the mint *and* its
   reversal both survive in the history.
3. **A counter cannot say where tokens went.** Every movement names the merchant
   and the order.

`reconcileAdminSupply` compares the running counter against the derived
double-entry total. That comparison is only *meaningful* because of (2) — a
counter you can decrement can be made to agree with anything.

**It also found a shipped bug.** The cross-store suite was the first test ever to
call this path against a real MongoDB, and it threw immediately: `$expr` combined
with `upsert` is refused by MongoDB, so **admin token issuance had never worked**
— both routes returned 500 on every call. Recorded as M-6 in
`MONGO_MONEY_AUDIT.md`. Worth remembering the next time something looks correct
on inspection.

Blocked on `infrastructureTested`, like every other eligible path, and on the
ordering gate: `merchant_wallet` must actually be flipped first.

### `settlements`, `bonuses_and_commissions`
No Postgres implementation, mirror or reconciliation. Declared here so the gap is
visible and so setting their variables fails loudly.

## How to read a "no" here

An ineligible path is not broken — it works correctly on MongoDB today, with
tests. "Not eligible" means only that **PostgreSQL cannot yet be its source of
truth**. Nothing in this table is a live defect.

The one thing this table forbids is claiming otherwise via configuration.
