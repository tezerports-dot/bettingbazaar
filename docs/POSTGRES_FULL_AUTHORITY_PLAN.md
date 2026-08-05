# PostgreSQL full financial authority — migration plan

**Status: `POSTGRES_FULL_FINANCIAL_AUTHORITY = NOT READY`** — 2 of 11 paths
implemented. Current state per path: `docs/FINANCIAL_DOMAIN_MATRIX.md`.
Per-domain certification: `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md`.

This is a financial migration, not an environment-variable change. This document
sequences it and records what is done.

Progress is one domain at a time, and each domain is finished — routing,
mirroring, reconciliation, rollback, metrics, tests — before the next begins.
Two are done. The sequence below says which is next and why.

---

## Done: the false-authority gate (§1)

The one part that had to land before anything else, because it makes every
later step safe to do incrementally.

**The problem.** `moneyAuthority.js` declared four paths; only `wallet` had an
implementation. `MONEY_AUTHORITY_LEDGER=postgres` was accepted, passed the
coherence check, and changed nothing — while the config, the boot log and the
`bb_money_authority_postgres` gauge all reported a cutover that had not
happened. Five other money paths (merchant wallet, merchant settlement, admin
issuance, bets, settlements, bonuses) were not modelled at all, so their absence
was invisible.

**What now exists** in `backend/postgres/moneyAuthority.js`:

- A **capability registry**: per path, `implemented` / `dualWrite` /
  `reconciled` / `rollback`, with notes and the derived `cutoverEligible`.
- **All 10 money paths declared**, including the six that were missing.
- `authorityFor()` **returns `mongo` for an ineligible path** regardless of
  configuration — fails safe for scripts, workers and anything that skips boot
  validation.
- `validateAuthorityConfig()` makes a production boot **refuse to start** with
  the specific missing capabilities named.
- `authorityMatrix()` exposes capability alongside `effective`, so health and
  metrics report where money *actually* lives.
- `fullFinancialAuthorityStatus()` returns the READY/NOT READY verdict.

**Evidence** (`5efa7fd`+): 448 unit tests pass, including 11 new authority
tests. Boot verified twice — `MONEY_AUTHORITY_LEDGER=postgres` exits 1 with
`'ledger' is NOT eligible for cutover — missing: implemented`; the eligible
`wallet` path still boots and flips.

**Residual risk.** The registry is hand-maintained. A `true` set without the
backing code would restore the exact hazard this removes. Treat a capability
flag change as a money change: it needs the reviewer to see the reader, the
writer, the reconciliation query and the rollback path.

---

---

## Done: merchant wallet (domain 1)

Full detail in `docs/FINANCIAL_DOMAIN_MATRIX.md`. In short: `merchantWalletPg.js`
+ `merchantWalletPgAuthority.js`, routed from `merchantWallet.service.js` through
the resolver; balance and ledger mirrored in both directions; two reconcilers in
the 5-minute pass; `bb_balance_drift_paise` and
`bb_money_operations_total{path,store,operation,outcome}` published; 50 tests
against real PostgreSQL including 200-way races and retry storms.

**Evidence:** 452 unit tests and 101 PostgreSQL tests pass. The capability flags
moved only after each of the four was separately built and tested — the same
standard that kept them at `false` while `merchantWalletPg.js` already existed.

Three defects were found and fixed while completing it, each of which would have
made the cutover silently wrong:

1. **The merchant ledger mirror never recorded a balance.** The Postgres mirror
   is hooked on the model's post-save, which fires when the service *reserves*
   its ledger row — `balanceAfter` is still null at that moment, and the
   completion is an `updateOne`, which is not a document save. Every merchant
   row ever mirrored carried `balance_after_paise = NULL`: the one column a
   rollback reads to restore `Merchant.tokenBalance`.
2. **`connectGuarded` leaked an error listener per checkout.** A pool hands the
   same client back each time, so listeners accumulated on long-lived
   connections. It announced itself as `MaxListenersExceededWarning: 11 error
   listeners` after a few hundred transactions in the suite.
3. **`merchant_wallet` depended on the wrong path.** It was modelled as
   depending on `ledger`, which it never touches — a merchant movement writes its
   own ledger inside its own transaction. Its real dependency is `wallet`, and
   that one is transactional: a deposit confirmation debits the merchant and
   credits the user inside ONE Mongo session, so putting those two balances in
   different stores means an abort between them leaves the merchant debited and
   the user uncredited.

An eleventh money path was also declared: **`casino_settlement`**. Provider
callbacks move real balances and no path described them.

### Cutover steps for this domain, in order

```bash
# 1. Prove the stores agree, repeatedly, over a sustained window.
npm run reconcile:pg -- --all          # exits 1 on any drift

# 2. Give the Postgres ledger a starting point. Idempotent; refuses to launder
#    a balance that moved without an entry.
npm run reconcile:pg -- --open-merchant-ledgers

# 3. Flip, in dependency order — the wallet MUST move first or the boot refuses.
MONEY_AUTHORITY_WALLET=postgres
MONEY_AUTHORITY_MERCHANT_WALLET=postgres

# Rollback: remove both variables and redeploy. The reverse mirror has kept
# Mongo current per movement, so this is a revert, not a restore.
npm run reconcile:pg -- --repair-mongo   # backstop for anything the mirror dropped
```

---

## Next: the one design decision blocking domain 2

Merchant ↔ user settlement needs multi-pocket movements (available → reserved →
settlement). Postgres expresses one as several entries under
`<txId>:<pocket>`. Mongo's `MerchantWalletLedger` has no pocket concept and its
idempotency gate is `findOne({ txId })` on the caller's bare key, so those rows
are invisible to it — which is why `reverseMirrorMerchantMovement` refuses to
mirror a multi-leg movement rather than write keys the gate cannot match.

Until that is resolved, settlement can be built in Postgres but has **no
fallback**: flipping it would be one-way.

**Proposed fix: a `movementId` field**, indexed and NOT unique, carrying the
caller's logical key, alongside the existing unique per-row `txId`. The gate
becomes `findOne({ movementId })` — an exact match that finds every leg of a
movement regardless of how many rows it produced.

**Explicitly rejected: a prefix match** (`findOne({ txId: /^key:/ })` or a SQL
`LIKE`). This audit already found and fixed exactly that bug in `walletPg`: a
shorter key silently swallows a longer one, so `bet_1` matches
`bet_10:available` and a distinct movement reads as already-applied. A prefix is
not an identity.

This is a change to a live money path's idempotency gate, and verifying it needs
a running MongoDB, which the development environment cannot provide
(`fastdl.mongodb.org` returns 403 through the proxy). It is therefore written
down rather than shipped unverified — **NOT IMPLEMENTED**, and it is the first
task of domain 2, to be done where the integration suite can run.

---

## Sequencing

The brief proposes: ledger → merchant wallet → orders → bets → bonuses →
**user wallet last**. The `dependsOn` graph says **wallet first**, because
ledger/orders/kyc are derived from balances and cannot be authoritative while
balances are not.

**Wallet-first stands**, and merchant wallet is now second. That is not a
compromise between the two positions — it follows from what the code does. The
`merchant_wallet → ledger` edge was wrong and has been removed; its real
dependency is `wallet`, for the transactional reason recorded above. Everything
else keeps the existing order.

If you still prefer wallet-last, the ledger must first be made independent of
balance ownership (entries carrying their own before/after rather than deriving
them). That is additional design work, not a reordering.

## Per-domain sequence

For each domain, in order. Do not start step *n+1* before *n* is evidenced.

1. **Contract and invariants** — what must be true after every operation.
2. **Schema + implementation** — integer smallest units; balance and ledger in
   one transaction; idempotency key unique-indexed.
3. **Regression and concurrency tests** against real PostgreSQL.
4. **Dual-write** with durable failure recording (not `.catch(() => {})` —
   see M-3).
5. **Backfill** historical data.
6. **Continuous reconciliation** proving agreement.
7. **Shadow reads** — read both, serve Mongo, count mismatches.
8. **Cut over reads.**
9. **Cut over writes** — flip the capability flag, then the env var.
10. **Keep reverse mirror** for the observation period.
11. **Remove Mongo authority** only after that period is clean.

## Remaining work, largest first

| Domain | Why it is next | Rough shape |
|---|---|---|
| **Merchant ↔ user settlement** | Next: its Postgres primitives already exist and are tested, so it is the shortest path to a third complete domain | Wire `reserveForSettlement` / `cancelReservation` / `completeReservation` / `payoutSettlement`. **Blocker to solve first:** `MerchantWalletLedger` cannot represent a per-pocket movement, and the reverse mirror refuses one rather than write keys Mongo's gate cannot match. Give it a pocket field, or accept that this domain is Postgres-only with no fallback |
| **Admin treasury** | Half-covered and therefore misleading: the merchant side of an issuance already rides on `merchant_wallet`, the treasury side is unrecorded | Split into accounts — house reserve, commission pool, bonus pool, referral pool, operational float, merchant float — each with its own ledger. `reserveAdminMint`'s 10B cap becomes a real balance |
| **Payment orders** | State machine + out-of-order provider callbacks | Expected-previous-state transitions; immutable history; ledger in the same transaction |
| **Bets + stake reservation** | Must fix M-2/M-4 in the design | Idempotency key from stable request identity, not a fresh UUID per attempt; lifecycle states enforced by constraint |
| **Casino settlement** | Newly declared; provider callbacks bypass the bets path | Every callback type idempotent by provider tx id. A ROLLBACK or REFUND must prove a matching prior debit — it currently does not |
| **Sports settlement** | Depends on bets | — |
| **Bonuses and commissions** | Depends on ledger + wallet | — |
| **Accounting ledger** | Everything posts to it, but nothing reads Postgres for it today | Constraints so malformed entries cannot insert; conservation triggers already exist |

## Cutover gate

Full authority may be enabled only when **all** hold:

- [ ] Every financial path has a real PostgreSQL implementation
- [ ] All financial call sites route through the authority resolver
- [ ] All concurrency suites pass
- [ ] Infrastructure resilience certification passes
- [ ] Continuous reconciliation reports zero unexplained mismatches
- [ ] Backup restoration rehearsed
- [ ] Rollback rehearsed
- [ ] Multi-instance load testing passes
- [ ] Monitoring and alerts active
- [ ] The registry reports every path `cutoverEligible`
- [ ] `npm run certify:report` exits 0

Until then the status stays `NOT READY`, and the code makes it impossible to
claim otherwise through configuration.

## Related

- `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` — per-domain go-live state, generated
- `docs/FINANCIAL_DOMAIN_MATRIX.md` — current per-path state
- `docs/MONGO_MONEY_AUDIT.md` — M-1 fixed, M-2/M-4 open, both due in the bets port
- `docs/CONCURRENCY_CERTIFICATION.md` — what is proven, what needs staging
- `docs/PRODUCTION_ARCHITECTURE.md` — why the wallet flip waits until after launch
