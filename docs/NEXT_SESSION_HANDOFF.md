# Next session handoff

Branch: `claude/postgres-migration-orders-ledger-kyc-fn9hq8` · PR #121 (draft)

Read this file, then `docs/BETS_SETTLEMENT_ROUTING.md`. Everything else is
reachable from those two.

---

## 1. Where the migration stands

**10 of 11 money paths are cutover-eligible.** All eleven have dual-write,
reconciliation and rollback. Only BETS is short, and only on `implemented`.

Read the live state, never a summary — including this one:

```bash
npm run certify:report
```

With every `MONEY_AUTHORITY_*` set to `postgres`, the resolver today gives:

```
9/11 resolve to postgres
mongo  bets          not eligible
mongo  settlements   blocked by: bets      ← one unrouted domain holds two paths
```

**Nothing is authoritative in Postgres right now.** No environment variable is
set, and that is correct for launch day — `docs/GO_LIVE_RUNBOOK.md` opens by
saying the migration is not a launch blocker.

## 2. THE job: finish BETS settlement routing

`postgres/betPgAuthority.js` → `settleBetOnPostgres()` is **built and unused**.
Both call sites were wired and reverted. Three blockers, all in
`domains/markets/gameEngine.js`:

**(a) The winner aggregation loses the funding provenance.** Around line 255:

```js
bets: { $push: { betId: "$_id", amount: "$amount",
                 fromDeposit: "$fromDepositBalance",
                 fromWinnings: "$fromWinningsBalance" } }
```

The names are not the Bet document's, so `slicesFromBet` reads `undefined`, and
**`fromReserveBalance` is not projected at all**. `betPg.settle`'s
`requireSlices` demands the slices sum exactly to the stake, so a reserve-funded
bet throws. Project all three under their real names.

**(b) `betStamps` carries `{betId, payout, platformFee}` and no bet document.**
The adapter needs the document for its slices. One-line change at ~line 284.

**(c) The winning path writes a `Transaction` log (`txOps`)** that a Postgres
branch would skip. Decide whether that log follows authority or stays Mongo-side.
It is a decision, not an oversight.

### Rules for this change

- **All or nothing.** Routing the losing side and not the winning side leaves
  half the lifecycle authoritative in each store — the split no reconciliation
  can tell apart from real disagreement. This is why ORDERS was done as one seam.
- The per-bet loop **already exists** on both sides (`for (const bet of
  losingBets) await unlockLostBet(...)`). Routing does not introduce an N; it
  replaces N wallet ops + a bulk stamp with N atomic transactions. An earlier
  analysis in the design doc said otherwise and is corrected in place.
- The bulk `updateMany` / `bulkWrite` must NOT run on the Postgres branch — the
  reverse mirror has already written each status, and re-stamping would
  overwrite bets Postgres deliberately refused, turning a reported failure into
  a silent one.

Then flip `implemented: true` for BETS on CI evidence → 11/11 eligible.

## 3. Then the flip

In this order. Steps 2–4 are deploy actions, not code.

1. `npm run reconcile:pg -- --all --backfill` — **run this first.** It now calls
   `backfillLifecycleTables()`, which adopts `order_states`, `user_kyc`,
   `casino_transactions` and `bets`. Before that existed these four were
   reachable by nothing, and flipping pointed reads at empty tables. Adoption
   never overwrites, invents no history, and is safe to re-run.
2. Confirm `reconcile:pg` reports clean, repeatedly.
3. Set `MONEY_AUTHORITY_*=postgres` per path, **in dependency order** — wallet
   first. Boot refuses an incoherent combination by design.
4. Watch `bb_money_authority_postgres`, `bb_pg_drift_rows`,
   `bb_pg_reconcile_consecutive_clean`.

Rolling back is a redeploy: unset the variable. The reverse mirrors keep Mongo
current while Postgres is authoritative, which is what makes that lossless.

## 4. Open findings — NOT actioned, NOT verified

**The deposit/reserve credit sites disagree with each other.** Three sites, three
fallbacks:

| Site | Expression |
|---|---|
| `merchant.routes.js:979` | `order.depositAllocation ?? order.tokenAmount` |
| `merchant.routes.js:1847` | `order.depositAllocation` — no fallback |
| `payment.routes.js:111` | `order.depositAllocation \|\| order.tokenAmount` |

`||` treats `0` as absent. Under a policy with `reserveAllocationPercent: 100`,
`depositAllocation` is `0`, and that site would credit the **full token amount**
to deposit *and* the reserve separately. `??` does not have that problem, and
the third site credits `undefined` for an order predating the fields.

The policy percentages themselves ARE validated to sum to 100
(`depositPolicy.service.js`), so the ratio is sound — the inconsistency is in
the three readers. **I have not tested any of this.** Verify before changing.

**KYC documents are still at permanent public CDN URLs.** The private R2 store
is built (`services/kycDocuments.service.js`) and tested, but the migration is
not done: objects not copied, panels not repointed, and **the originals not
deleted from the public bucket**. Until that last step the exposure is
unchanged. `docs/KYC_DOCUMENT_STORAGE.md` has the sequence.

**`infrastructureTested` is 0/11.** One staging campaign unblocks all eleven —
`GO_LIVE_RUNBOOK.md` §2.2. Restart Postgres under load, restart Mongo's primary,
kill a backend mid-transaction, run two app instances.

**Nobody has run the app.** No boot, no smoke test, no `stack:up`. The runbook's
item 4 (hand smoke-test on staging) and item 2 (`npm run test:all` against real
services, never once executed) are the highest-value unstarted work in the repo.

## 5. What this session changed on the LIVE Mongo path

These are real fixes sitting in a draft PR. Merging is worth doing on its own,
independent of the migration:

- **Admin dispute resolution always returned 409.** `DISPUTED` had no outgoing
  edge in the shared rule table, so both resolve routes refused the one status
  they exist to handle. Shipped in #119; live until #121 merges.
- **Every rejected KYC user was told nothing.** The reason was written to
  `user.kyc.rejectionReason`; the schema has no `kyc` subdocument, only
  `kycData`. The block never ran.
- **Nine sites moved money before the status guard**, so concurrent
  approve/reject ran both.
- Order status writes are now guarded in the update's filter, everywhere.

## 6. Environment notes

- **PostgreSQL runs locally.** `/usr/lib/postgresql/16/bin`, start it as the
  `postgres` user. `test:pg` runs in the sandbox — use it, it catches real bugs.
  CI uses PG 18; local is 16.
- **MongoDB does NOT run here.** `fastdl.mongodb.org` is blocked by network
  policy, so `test:integration` is CI-only. Integration suites now **throw**
  rather than skip when `CI=true` and `DATABASE_URL` is unset, so a green CI run
  proves they actually executed.
- Local Postgres died three times during the session. Restart it and re-run;
  it is not a code failure.

## 7. Standards this branch has held to

Keep these. They caught most of what was found.

- **Never mark PASS on inspection. Run it.** Two of this session's three worst
  bugs were found by running something, not by reading it.
- **Mutation-test every fix**: break it, confirm a test fails, restore, and say
  which. Nineteen mutations this session; every one killed its intended test.
- **No authority flag moves** until implementation, tests, reconciliation,
  observability and rollback all exist AND CI is green.
- **Mark anything unverified as NOT VERIFIED.** Section 4 above is written that
  way on purpose.
- **Stop and document architectural decisions likely to fail at scale** rather
  than implementing them under pressure.

## 8. Two corrections recorded in this branch, both mine

Both are in `docs/BETS_SETTLEMENT_ROUTING.md`, left visible rather than deleted:

1. I claimed routing bet settlement replaced one bulk statement with N
   transactions on a hot path. The per-bet loop already existed one function
   above. I reasoned about the statement, not the loop around it.
2. I claimed a reserve-funded bet might have its locked stake under-released on
   the live path. Measured: `releaseLockedStake` releases with `amount`, the
   full stake — the slices only move provenance counters, and reserve has none
   by design. Not a bug.

Same shape both times: reasoning about a call's arguments without reading what
the call does with them. Worth knowing about the analysis in this branch.
