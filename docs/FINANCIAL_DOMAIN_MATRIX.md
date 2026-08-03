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

10 declared paths. **1 implemented, 1 built-but-unrouted, 8 not started.** 0 currently on Postgres.

## The matrix

| Path | Impl | Dual-write | Reconciled | Rollback | Eligible | Authority |
|---|:--:|:--:|:--:|:--:|:--:|---|
| `wallet` | ✅ | ✅ | ✅ | ✅ | **YES** | mongo |
| `ledger` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `orders` | ❌ | ✅ | ✅ | ✅ | no | mongo |
| `kyc` | ❌ | ✅ | ❌ | ✅ | no | mongo |
| `merchant_wallet` | 🟡 | ⚠️ | ❌ | ❌ | no | mongo |
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

### `merchant_wallet` — 🟡 implementation built, routing not wired
`postgres/merchantWalletPg.js` now exists: `merchant_wallets` (available /
reserved / settlement pockets, integer paise) + `merchant_wallet_entries`
(append-only, arithmetic CHECK, UNIQUE `tx_id`). One transaction per movement,
row locked with `SELECT … FOR UPDATE`, guard in the `UPDATE`'s `WHERE`, entry
written in the same transaction. **24 tests green against PostgreSQL 16**,
including 200 racing reservations against a balance that fits 100 (exactly 100
commit), a 200-way retry storm on one key (applied once), append-only
enforcement, and reconciliation drift of zero.

Operations: admin issuance/deduction, reserve, cancel, complete, payout,
reversal, plus `reconcileMerchant()`.

**Still `implemented: false` in the registry, deliberately.** That flag also
requires production call sites to route through the authority resolver, and
`merchantWallet.service.js` does not consult it yet. Code that exists but is not
reached is not authority — flipping the flag now would recreate the exact hazard
the registry exists to prevent.

Remaining before this path can cut over:
1. Route `merchantWallet.service.js` through `isPostgresAuthoritative()`
2. Mirror the **balance**, not just the ledger
3. Add it to the reconcile pass
4. Build the reverse mirror

Note the Mongo original's shape was carried across but expressed properly: its
reserve→complete used a ledger row with a null `balanceAfter` that a crash could
strand; here a reservation is a real balance movement inside one transaction, so
it cannot be half-done.

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
