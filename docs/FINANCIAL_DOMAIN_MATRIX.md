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

10 declared paths. **1 implemented. 9 not.** 0 currently on Postgres.

## The matrix

| Path | Impl | Dual-write | Reconciled | Rollback | Eligible | Authority |
|---|:--:|:--:|:--:|:--:|:--:|---|
| `wallet` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `ledger` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `orders` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `kyc` | ❌ | ✅ | ❌ | ✅ | no | mongo |
| `merchant_wallet` | ❌ | ⚠️ | ❌ | ❌ | no | mongo |
| `merchant_settlement` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `admin_issuance` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `bets` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `settlements` | ❌ | ❌ | ❌ | ❌ | no | mongo |
| `bonuses_and_commissions` | ❌ | ❌ | ❌ | ❌ | no | mongo |

⚠️ `merchant_wallet` mirrors its **ledger** but not the **balance** — the number
that actually matters is Mongo-only and unmirrored.

## What each column means

- **Impl** — a real Postgres reader *and* writer exist, and production call
  sites route through `isPostgresAuthoritative()`. This is the column that was
  missing: `ledger`, `orders` and `kyc` had mirrors and reconciliation, so they
  *looked* ready, but nothing read Postgres and no call site consulted the
  resolver.
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

### `merchant_wallet` — nothing at all
`domains/merchant/merchantWallet.service.js` is the sole writer of
`Merchant.tokenBalance` and is entirely Mongo. Its ledger is mirrored; the
balance is not. This is the **largest single gap** — every user↔merchant
settlement and admin↔merchant issuance depends on it, so no meaningful
"Postgres owns the money" claim is possible until it exists.

Its Mongo implementation is sound: reserve the ledger row (`balanceAfter: null`),
move the balance, complete the row — so a crash leaves a detectable reservation
rather than an unaudited movement. Six concurrency tests pass against real
MongoDB. Port that shape to Postgres; do not port `_mongoBetStake`'s.

### `bets` — Mongo-only, with two known defects to fix in the port
`_mongoBetStake` has **no idempotency key** on the balance move (M-2) and writes
its ledger **outside** the transaction (M-4). Both are recorded in
`MONGO_MONEY_AUDIT.md`. The Postgres design must resolve them rather than carry
them across: a bet needs an idempotency key derived from stable request
identity, not a fresh UUID per attempt — a new UUID on every retry is not
idempotency, it is a new bet.

### `merchant_settlement`, `admin_issuance`, `settlements`, `bonuses_and_commissions`
No Postgres schema, implementation, mirror or reconciliation. Declared here so
the gap is visible and so setting their variables fails loudly.

## How to read a "no" here

An ineligible path is not broken — it works correctly on MongoDB today, with
tests. "Not eligible" means only that **PostgreSQL cannot yet be its source of
truth**. Nothing in this table is a live defect.

The one thing this table forbids is claiming otherwise via configuration.
