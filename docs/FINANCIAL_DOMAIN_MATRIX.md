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

11 declared paths. **2 implemented, 9 not started.** 0 currently on Postgres.

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
| `merchant_settlement` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `admin_issuance` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `bets` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `settlements` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `casino_settlement` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `bonuses_and_commissions` | ❌ | ❌ | ❌ | ❌ | no | mongo |

Neither eligible path has been flipped. Eligibility means only that the flip is
*permitted*; `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` covers what is still
required before it should happen.

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

### `merchant_settlement`, `admin_issuance`, `settlements`, `bonuses_and_commissions`
No Postgres implementation, mirror or reconciliation. Declared here so the gap is
visible and so setting their variables fails loudly.

`merchant_settlement` is the nearest: the Postgres primitives it needs
(`reserveForSettlement`, `cancelReservation`, `completeReservation`,
`payoutSettlement`, `reverseMovement`) already exist and are tested — nothing
calls them, and `MerchantWalletLedger` cannot yet represent a per-pocket movement.

`admin_issuance` is half-covered without being eligible: the MERCHANT side of an
issuance already rides on `merchant_wallet`, because the admin routes call
`creditMerchantTokens`. What is missing is the TREASURY side — the 10B supply cap
reserved by `reserveAdminMint` has no Postgres ledger, so a mint is only
half-recorded there.

## How to read a "no" here

An ineligible path is not broken — it works correctly on MongoDB today, with
tests. "Not eligible" means only that **PostgreSQL cannot yet be its source of
truth**. Nothing in this table is a live defect.

The one thing this table forbids is claiming otherwise via configuration.
