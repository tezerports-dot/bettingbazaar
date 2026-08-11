# Next session handoff

Branch: `claude/postgres-migration-orders-ledger-kyc-fn9hq8` · PR #121 (draft)

Read this file, then `docs/BETS_SETTLEMENT_ROUTING.md`. Everything else is
reachable from those two.

---

## 1. Where the migration stands

**11 of 11 money paths are cutover-eligible.** All eleven have a routed
implementation, dual-write, reconciliation and rollback. BETS was the last one
short, and only on `implemented`; settlement is routed now and the flag moved on
CI evidence.

Read the live state, never a summary — including this one:

```bash
npm run certify:report
```

With every `MONEY_AUTHORITY_*` set to `postgres`, the resolver gives:

```
11/11 resolve to postgres
POSTGRES_FULL_FINANCIAL_AUTHORITY = READY
```

The ordering gate opened **by itself**, because the domains it was waiting on
were completed. It was never touched. Removing `MONEY_AUTHORITY_BETS` alone
still puts SETTLEMENTS back on Mongo — there is a test for that, because "all
eleven resolve" would otherwise be just as consistent with the edge having been
deleted.

**Nothing is authoritative in Postgres right now.** No environment variable is
set, and that is correct — `docs/GO_LIVE_RUNBOOK.md` opens by saying the
migration is not a launch blocker.

`infrastructureTested` is **0/11** and is now the ONLY thing between eligible
and *certified*. One staging campaign unblocks all eleven (`GO_LIVE_RUNBOOK.md`
§2.2): restart Postgres under load, restart Mongo's primary, kill a backend
mid-transaction, run two app instances. No amount of code clears it.

## 2. THE job: the flip itself

There is no implementation work left before it. In this order — steps 2–4 are
deploy actions, not code.

1. `npm run reconcile:pg -- --all --backfill` — **run this first.** It calls
   `backfillLifecycleTables()`, which adopts `order_states`, `user_kyc`,
   `casino_transactions` and `bets`. Adoption never overwrites, invents no
   history, and is safe to re-run.
   **Read `created` and `notAdopted` per table.** `created` is now re-read from
   the table rather than counted as the loop goes, so a row a mirror declined or
   silently failed to write shows up as `notAdopted` instead of inflating the
   success count. A non-zero `notAdopted` on anything other than phantom bets
   wants investigating before you go on.
2. Confirm `reconcile:pg` reports clean, repeatedly.
3. Set `MONEY_AUTHORITY_*=postgres` per path, **in dependency order** — wallet
   first. Boot refuses an incoherent combination by design.
4. Watch `bb_money_authority_postgres`, `bb_pg_drift_rows`,
   `bb_pg_reconcile_consecutive_clean`.

Rolling back is a redeploy: unset the variable. The reverse mirrors keep Mongo
current while Postgres is authoritative, which is what makes that lossless.

**The schema change this branch adds applies itself.** `bets.platform_fee_paise`
arrives via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `schema.sql`, and
`server.js` runs `applySchema()` at boot. Verified against a database that
already had the table without the column: dropped it, re-applied, and both the
column and its CHECK constraint came back. Note `applySchema` is inside a
`Promise.allSettled` whose handler only logs — a failed apply does not stop the
boot, and the settling `UPDATE` would then fail on a 42703.

## 3. What this session changed

**BETS settlement routing (`1bd5de8`, CI run 31456526949 green).** Both sides
route from one decision read once per pass. The three recorded blockers are
cleared; blocker (c) is answered — the `Transaction` log stays Mongo-side and
runs on both branches, because it is the user's history feed and the auditable
record is `wallet_ledger` + `accounting_events`, which `betPg` writes inside the
settling transaction. A fourth blocker turned up in the wiring:
`bets.platform_fee_paise`, without which `Cycle.totalPlatformFees` would read
zero for every Postgres-settled cycle with every state check still green.

**A live money bug on the Mongo path (`4f548fe`).** See §4.

**Three smaller things, each found by running something:**

- `reconcileBetStates`' backfill leg fetched documents with `.select('status')`
  and handed them to `mirrorBet`, whose `ON CONFLICT DO UPDATE` writes what it
  is given — so repairing a status disagreement **zeroed that bet's payout and
  fee** in Postgres.
- Phantom bets were mirrored into Postgres. Synthetic, zero funding provenance,
  unsettleable by `betPg`, and they inflate `reconcileUserStakes` against a
  `lockedBalance` that never moved.
- `backfillLifecycleTables` reported `created` by incrementing a counter after
  calling a fire-and-forget mirror, so it counted attempts. The cutover's step-1
  report was the one number in the system most able to flatter itself.

## 4. The live bug this session found and fixed

**One deposit route was creating tokens.** Handoff §4 of the previous session
recorded that three sites read `depositAllocation` three different ways and
flagged the `||` as wrong under a 100%-reserve policy. It also said none of it
had been tested. Testing it found something larger, in the *ordinary* case:

`payment.routes.js` debited the merchant `depositAllocation || tokenAmount` and
credited the user `depositAllocation + reserveAllocation`. The split is a
question about the USER's side only; the merchant parts with the whole amount.
Measured by driving the real handler:

| policy | merchant | user | |
|---|---|---|---|
| 90/10 | −900 | +1000 | 100 created |
| 50/50 | −500 | +1000 | 500 created |
| 0/100 | −1000 | +2000 | 1000 created |

`domains/payment/depositCredit.js` now states the rule once and all three sites
read it. The fallback question was real but secondary, and it had a second axis
nobody had noticed: `depositAllocation` reads `0` through a hydrated Mongoose
document (schema default) and `undefined` through `.lean()`, so `??` fired or
did not fire depending on how the order was FETCHED.

## 5. Open findings — NOT actioned, NOT verified

**KYC documents are still at permanent public CDN URLs.** The private R2 store
is built (`services/kycDocuments.service.js`) and tested, but the migration is
not done: objects not copied, panels not repointed, and **the originals not
deleted from the public bucket**. Until that last step the exposure is
unchanged. `docs/KYC_DOCUMENT_STORAGE.md` has the sequence.

**The winner `Transaction` log can duplicate on a resumed settlement.**
Pre-existing and unchanged by the routing: bare inserts, no idempotency key, no
unique index. The money is safe (`creditWinnings` is keyed) — only the user's
history duplicates. Not fixed because the honest fix is a product decision: a
resumed pass pays a different, smaller amount for the remaining bets, so
upserting on (user, cycle) would replace the first row with a partial one.
Recorded in `docs/BETS_SETTLEMENT_ROUTING.md`.

**`/orders/:id/approve` does not filter on `order.type`.** It gates on status
`PAID` only, then runs the deposit credit path unconditionally. Whether a
WITHDRAWAL order can reach `PAID` was NOT investigated. Noticed while reading
for §4; nothing was changed.

**`infrastructureTested` is 0/11.** See §1.

**Nobody has run the app.** No boot, no smoke test. The runbook's item 4 (hand
smoke-test on staging) is now the highest-value unstarted work in the repo.

## 6. Environment notes

- **PostgreSQL runs locally.** `/usr/lib/postgresql/16/bin`, start it as the
  `postgres` user; make `/var/run/postgresql` writable by it first. `test:pg`
  runs in the sandbox — use it, it catches real bugs. CI uses PG 18; local is 16.
- **MongoDB does NOT run here, and now neither does `stack:up`.** The compose
  stack cannot start: `production.cloudfront.docker.com` (Docker Hub's blob CDN)
  returns 403 from the egress proxy, so no image pulls at all — not mongo, not
  postgres, not redis. This is an organization policy denial, not a
  misconfiguration; do not try to route around it. `test:integration` stays
  CI-only.
- **`npm run test:all` was executed for the first time this session.** Legs 1
  and 2 (`test:unit`, `test:pg`) ran green against the local Postgres. Leg 3
  failed on `ECONNREFUSED 127.0.0.1:27017` and took **13 minutes** to do it —
  26 files × a 30s connect timeout each. Worth knowing before you run it.
- `scripts/mutation-check.mjs` holds this branch's 27 mutations. Run it after
  touching any of the money paths it covers; add to it when you fix something.
- Local Postgres died once during this session, as it did in the last one.
  Restart it and re-run; it is not a code failure.

## 7. Standards this branch has held to

Keep these. They found everything worth finding.

- **Never mark PASS on inspection. Run it.** Every finding in §3 and §4 came
  from running something. The §4 bug had been read past twice and written up
  once as a smaller problem than it was.
- **Mutation-test every fix**: break it, confirm a test fails, restore, and say
  which. 27 mutations on this branch; **two survived on the first pass** and
  both were real holes — the mid-cursor batch flush had no coverage, and the
  deposit fallback had no route-level case. A mutation run that kills everything
  first time is weaker evidence than one that does not.
- **No authority flag moves** until implementation, tests, reconciliation,
  observability and rollback all exist AND CI is green. CI evidence, not local.
- **Mark anything unverified as NOT VERIFIED.** §5 is written that way on
  purpose.
- **Do not disable the ordering gate.** It opened this session because the
  domains were finished, which is the only way it is supposed to open.

## 8. One correction recorded in this branch

The previous session's §4 said the deposit/reserve problem was an inconsistency
between three readers. It is not — or not mainly. The readers did disagree, but
the defect that mattered was a mismatch between what one route DEBITED and what
it CREDITED, which no amount of staring at the three reader expressions would
have surfaced. The finding was written from reading the three lines the note
listed rather than the routes around them.

Same shape as the two corrections recorded in the previous session, and worth
the same caution: the analysis in these documents is reliable about the code it
quotes and unreliable about the code it does not.
