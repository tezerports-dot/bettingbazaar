# Production certification checklist

What is actually production ready, versus what is still under development.

This document exists to make "complete" a claim that can be checked. The table
below is **generated from the capability registry**
(`backend/postgres/moneyAuthority.js`) — nobody types a ✅ into it, so it cannot
drift from the code the way a hand-maintained checklist does.

```bash
npm run certify:report            # print it
npm run certify:report -- --write # regenerate the block below
```

The command exits non-zero while any money path is uncertified, so CI can gate
on it once every domain has landed.

---

<!-- BEGIN GENERATED: certification-matrix -->

**`NOT PRODUCTION CERTIFIED`** — 0 of 11 money paths certified.
Generated from `backend/postgres/moneyAuthority.js` by `npm run certify:report`. Do not edit by hand.

| Domain | PG Authority | Mirroring | Reconciliation | Concurrency Tested | Infrastructure Tested | Certified |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| User Wallet | ✅ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Merchant Wallet | ✅ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Accounting Ledger | ⏳ | ✅ | ✅ | ⏳ | ⏳ | ⏳ |
| Orders | ⏳ | ✅ | ✅ | ⏳ | ⏳ | ⏳ |
| KYC | ⏳ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ |
| Merchant ↔ User Settlement | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Admin Treasury / Token Issuance | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Betting | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Sports Settlement | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Casino Settlement | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Bonuses & Commissions | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

### What is blocking each domain

| Domain | Blocked by |
|---|---|
| User Wallet | infrastructureTested |
| Merchant Wallet | infrastructureTested |
| Accounting Ledger | implemented, concurrencyTested, infrastructureTested |
| Orders | implemented, concurrencyTested, infrastructureTested |
| KYC | implemented, reconciled, concurrencyTested, infrastructureTested |
| Merchant ↔ User Settlement | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |
| Admin Treasury / Token Issuance | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |
| Betting | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |
| Sports Settlement | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |
| Casino Settlement | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |
| Bonuses & Commissions | implemented, dualWrite, reconciled, rollback, concurrencyTested, infrastructureTested |

<!-- END GENERATED: certification-matrix -->

---

## What each column means

Six columns, and a domain is certified only when all six hold. The first four
are the *cutover* gate — they decide whether PostgreSQL may be the source of
truth. The last two are the *certification* gate, and they are deliberately
harder: a path can be fully implemented, mirrored, reconciled and
rollback-capable and still never have been raced or had its database restarted
underneath it.

| Column | Means | Enforced by |
|---|---|---|
| **PG Authority** | A real PostgreSQL reader *and* writer exist, and production call sites route through `isPostgresAuthoritative()` | `authorityFor()` returns `mongo` regardless of configuration; production boot refuses to start |
| **Mirroring** | Mongo writes reach PostgreSQL (Phase A) and PostgreSQL writes reach Mongo (Phase B) | `dualWrite.js`, `reverseMirror.js` |
| **Reconciliation** | A pass compares both stores — balances, not just row presence — and can prove they agree | `reconcile.js`, run every 5 minutes by `cronJobs.js` |
| **Concurrency Tested** | Raced against itself on a real database: parallel writers on one balance, retry storms on one key | The named test file in `TESTING` |
| **Infrastructure Tested** | Survived its infrastructure failing: database restart mid-transaction, connection loss, process kill, multi-instance contention | **Nothing yet — see below** |
| **Certified** | All six | `certificationFor()` |

## Infrastructure testing is NOT VERIFIED for every domain

Including the two that are otherwise complete. This is the honest state, not an
oversight, and it is the single largest gap between this platform and a
production go-live.

These drills need things the development environment does not have:

- a running MongoDB to restart (the `mongod` binary cannot be downloaded in the
  build sandbox — `fastdl.mongodb.org` returns 403 through the proxy)
- more than one application instance, to test contention between them
- a load balancer and a Redis to restart
- a replica to promote, and a backup to restore from

Every one of them is **staging work**, and none of it can be simulated here
honestly. What follows is the specification for those runs, so they can be
executed and recorded rather than approximated.

### The drill (Phase 3 — single node)

While continuously placing bets and settling orders, one at a time:

| Action | Must remain true |
|---|---|
| Restart PostgreSQL | no lost money, no duplicate money, no orphan reservation |
| Restart MongoDB | ditto, plus the mirror catches up |
| Restart Redis | ditto, plus sessions and queues recover |
| Restart one app instance | in-flight requests fail cleanly or complete once |
| Kill the app (SIGKILL) | no half-applied movement survives |
| Kill a database connection mid-transaction | the transaction unwinds; the retry is idempotent |
| Restore PostgreSQL / Redis | reconciliation returns to zero drift |

Invariants checked after every one: **no lost money, no duplicate money, no
duplicate ledger row, no orphan reservation, no negative balance, ledger ==
balances, retries idempotent, settlement idempotent.**

The primitives to check them already exist and are automated:
`reconcileMerchantBalances`, `reconcileMerchantLedgers`, `pgTrialBalance`,
`mongoTrialBalance`, `compareTrialBalances`.

### Phase 4 — multi-node

3 application nodes, 1 Redis, 1 PostgreSQL, 1 MongoDB. 1000 concurrent users,
duplicate retries, duplicate webhooks, injected network delay and packet loss,
timeouts, a slow database, a Redis restart, a node restart. The k6 scenarios in
`loadtest/` are the starting point; they do not yet cover duplicate webhooks or
node restarts.

### Phase 7 — disaster recovery

Restore from backup, PITR, replica promotion, failover, split-brain prevention,
backup verification, recovery verification. None rehearsed.

## Continuous financial verification (Phase 5)

Runs every 5 minutes today, not hourly, and covers the paths that have a
PostgreSQL representation:

```
ledger == balances == merchant wallets    difference allowed: ₹0.00
```

`bb_balance_drift_paise` must be 0 and `bb_pg_reconcile_consecutive_clean` must
stay high. Treasury, reserve, bonus and commission are **not** in this check
yet — they have no PostgreSQL ledger to compare against, which is what their
domains have to build.

## Observability (Phase 6)

Live now:

| Metric | Answers |
|---|---|
| `bb_money_operations_total{path,store,operation,outcome}` | every balance mutation, by path and store — transactions, retries (`outcome="idempotent"`), refusals |
| `bb_balance_drift_paise{path}` | do the two stores hold the same number |
| `bb_balance_drift_accounts{path}` | how many accounts disagree |
| `bb_pg_drift_rows`, `bb_mongo_drift_rows` | rows missing from either store |
| `bb_ledgers_agree` | do the two ledgers agree account by account |
| `bb_pg_reconcile_consecutive_clean` | the cutover-readiness streak |
| `bb_money_authority_postgres{path}` | where money actually lives right now |
| `bb_pg_pool_connections{state}` | pool exhaustion |
| `bb_pg_query_duration_seconds` | database latency |
| `bb_unaudited_money_movements_total` | a balance moved without its audit row |

Still missing: `postgres_deadlocks_total`, `redis_disconnect_total`,
`mongo_replication_lag`, `pg_replication_lag`. The last two require replicas,
which is Phase 7 work.

## Go-live gate

The platform may be called production ready only when **all** hold:

- [ ] PostgreSQL is authoritative for every financial domain
- [ ] MongoDB holds only mirrored or non-financial data
- [ ] Every money operation is ACID, idempotent, append-only and reconciled
- [ ] Infrastructure resilience drills pass under restarts, failures and partitions
- [ ] Multi-instance concurrency tests pass
- [ ] Payments, betting, token exchange, merchant settlement and treasury all have automated regression tests
- [ ] Continuous reconciliation reports zero drift across every financial ledger
- [ ] `npm run certify:report` exits 0

## Related

- `docs/FINANCIAL_DOMAIN_MATRIX.md` — per-path detail and what each ⏳ needs
- `docs/POSTGRES_FULL_AUTHORITY_PLAN.md` — the migration sequence
- `docs/MONGO_MONEY_AUDIT.md` — defects that must be fixed in the port, not carried across
- `docs/CONCURRENCY_CERTIFICATION.md` — what concurrency is proven and how
