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
| Accounting Ledger | ⏳ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Orders | ⏳ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| KYC | ⏳ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ |
| Merchant ↔ User Settlement | ✅ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Admin Treasury / Token Issuance | ⏳ | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Betting | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Sports Settlement | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Casino Settlement | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Bonuses & Commissions | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

### What is blocking each domain

| Domain | Blocked by |
|---|---|
| User Wallet | infrastructureTested |
| Merchant Wallet | infrastructureTested |
| Accounting Ledger | implemented, infrastructureTested |
| Orders | implemented, infrastructureTested |
| KYC | implemented, reconciled, concurrencyTested, infrastructureTested |
| Merchant ↔ User Settlement | infrastructureTested |
| Admin Treasury / Token Issuance | implemented, infrastructureTested |
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

## Cross-domain conservation

Domain suites prove a domain in isolation, and every one of them can pass while
money is lost at the SEAMS between domains — a domain test only ever sees one
side of a transfer. A merchant debit of ₹2,000 and a user credit of ₹1,900 are
each individually correct.

`backend/tests/postgres/moneyConservation.test.js` walks the whole chain —
admin issuance → merchant → user deposit → bet stake → settlement → winnings →
withdrawal → merchant → payout — and after **every step** asserts:

```
Σ(merchant pockets) + Σ(user balances) + attributed sinks == total ever issued
```

Tokens move between holders, enter by explicit issuance, or leave to a named
sink the test must declare. There is no fourth option. Verified by mutation: a
₹100 discrepancy at the deposit seam fails the run with the full trail, and
that check is re-run whenever the file changes.

**The books now close.** The `sink` variable was a placeholder for value that
legitimately leaves these books — a losing stake to the house, a commission to
the platform — with nowhere to go. The treasury domain gave it somewhere, and
the same file now carries a second scenario with **no sink at all**, checking
two things after every step:

1. the treasury trial balance sums to zero — nothing was invented
2. `MERCHANT_FLOAT` and `USER_FLOAT` equal the actual wallet sums — the
   platform's own books and its customers' books tell the same story

(2) is the claim no isolated suite can make. A companion test demonstrates the
failure it catches: a treasury posting that never happened in the wallets leaves
both ledgers internally consistent while they disagree about the same money.

## Running the whole suite locally

Every suite, including the Mongo-dependent ones, without GitHub Actions:

```bash
npm run stack:up     # Mongo (single-node replica set), PostgreSQL 18, Redis
npm run test:all     # unit → postgres → integration, against that stack
npm run stack:down
```

The replica set is not decoration: 31 call sites open a Mongo transaction and
MongoDB refuses those on a standalone server, so a plain `mongo` container
passes a smoke test and fails every money path. (It is also why the Railway
MongoDB plugin cannot host this application.)

This exists because "only CI can run these tests" is not an acceptable property
for the suites that guard money — and it cost exactly what you would expect: a
defect reached CI that a local run catches in seconds.

**NOT VERIFIED by the author.** The Docker daemon is unreachable in the
development sandbox, so the compose file has been written but never started.
First run should be treated as a shakedown.

## Related

- `docs/MIRROR_EXIT_PLAN.md` — how the dual-write scaffolding gets **removed**, per domain
- `docs/FINANCIAL_DOMAIN_MATRIX.md` — per-path detail and what each ⏳ needs
- `docs/POSTGRES_FULL_AUTHORITY_PLAN.md` — the migration sequence
- `docs/MONGO_MONEY_AUDIT.md` — defects that must be fixed in the port, not carried across
- `docs/CONCURRENCY_CERTIFICATION.md` — what concurrency is proven and how
