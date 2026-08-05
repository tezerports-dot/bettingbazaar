# Go-live runbook

**Read this first: launching does NOT mean finishing the PostgreSQL migration.**

Every money path defaults to MongoDB. No authority flag is flipped, and none
should be on launch day. The Postgres work is a *parallel* system that mirrors,
reconciles and is ready to take over later — one path at a time, months after
launch if you like. Treating the migration as a launch blocker would be
backwards: it exists to reduce risk, and flipping it under launch pressure is
the one way to make it increase risk instead.

So this document is in two halves:

- **Part 1 — launch on MongoDB.** What must be true before you take real money.
- **Part 2 — the migration, afterwards.** One path at a time, at your pace.

---

## Part 1 — Launch on MongoDB

### 1.1 What is already done

| | |
|---|---|
| **M-1** double-charge on a re-split bet replay | Fixed in Mongo, CI-tested |
| **M-6** admin token issuance threw on every call | Fixed in Mongo, CI-tested |
| **M-7** casino rollback could mint money | Fixed in Mongo, CI-tested |
| **M-3** swallowed ledger errors | Now metered and logged |
| Idempotency key required on admin mints | Enforced; admin panel sends one |

M-6 is worth pausing on: **admin token issuance had never worked.** `$expr`
combined with `upsert` is refused by MongoDB, so both admin mint routes returned
500 on every call since they shipped. If you have never successfully topped up a
merchant, that is why. Test it explicitly before launch.

### 1.2 What is still open on the Mongo path

**M-2 and M-4 — the bet stake movement.** The balance move has no idempotency
key and the ledger is written outside the transaction. Both are *latent*:
`bet.routes.js` mints a fresh key per request, so a retry creates a second bet
rather than double-charging one. That is survivable but not good — a retried bet
is a bet the player did not intend to place.

**The fix requires a decision you should make deliberately**, not under launch
pressure. It is documented in `docs/MONGO_MONEY_AUDIT.md` under "Proposed
design", and the tradeoff is latency on the hottest path in the system. Measure
first with `loadtest/bet-contention.js` on staging.

**Client idempotency keys on bet placement.** The backend accepts an
`Idempotency-Key` header and uses it when present. No client sends one yet. Until
they do, a retried bet is a second bet. Adding it to the user panel — and to the
Android app when you build it — closes this without any backend change.

### 1.3 Pre-launch checklist

Work top to bottom. Do not skip 4 or 6.

1. **Infrastructure.** MongoDB must be a **replica set** — not a standalone.
   31 code paths open a Mongo transaction, and MongoDB refuses transactions on a
   standalone server. A plain `mongod` passes a smoke test and fails every money
   path. This is the single most common way this platform breaks on a new host.
   Railway's MongoDB plugin is a standalone; it will not work.

2. **Run the full suite against real services.**
   ```bash
   npm run stack:up          # Mongo replica set + Postgres + Redis, in Docker
   npm run test:all          # unit + postgres + integration
   npm run stack:down
   ```
   `docker-compose.test.yml` is written but **has never been run** — it could not
   be verified in the build sandbox. Expect to fix something the first time.

3. **Environment.** Copy `.env.example` and fill it. Boot will refuse to start on
   a config that lies about where money lives, which is deliberate.
   Leave every `MONEY_AUTHORITY_*` **unset**.

4. **Smoke-test the money paths by hand, on staging, with real accounts.**
   Not optional and not automatable — you are checking that the *system* works,
   not that the code does:
   - deposit through a merchant, end to end
   - withdrawal through a merchant, including the hold window expiring
   - a bet placed, a cycle settled, winnings credited
   - **an admin top-up of a merchant** (this is M-6; it has never worked)
   - a casino round: bet, win, and a rollback (this is M-7)
   - a dispute inside the withdrawal hold window

5. **Reconciliation running.** `npm run reconcile:pg` on a schedule. It should
   report clean. It is detection-only unless you pass `--backfill`.

6. **Backups, and a restore you have actually performed.** A backup you have
   never restored is not a backup. Do this before you take real money.

7. **Alerting reaches a human.** `sendAlert` fires on withdrawal-hold failures,
   mirror failures and reconcile drift. Confirm one actually reaches you.

8. **KYC files in object storage.** Cloudflare R2 or another S3-compatible
   store — not Mongo, not Postgres blobs.

9. **The legal part.** Real-money betting is licensed in most jurisdictions.
   That is not something this codebase can answer for you, and it is a worse
   problem to discover after launch than before.

---

## Part 2 — The PostgreSQL migration, afterwards

### 2.1 Where it stands

Eleven money domains, all with a Postgres implementation, all concurrency-tested
against a real PostgreSQL. **Zero are certified**, and the honest reason is one
thing: `infrastructureTested` is false for all eleven, and it cannot be made true
in a build sandbox. It needs a staging environment and a deliberate afternoon.

Read the live state — never a summary of it, including this one:

```bash
npm run certify:report
```

### 2.2 The one exercise that unblocks everything

`infrastructureTested` blocks all eleven domains. It is **one campaign**, not
eleven, and it is the highest-leverage thing left. On staging, with the full
stack running and load applied (`loadtest/bet-contention.js`):

1. Restart PostgreSQL mid-load. Money paths must recover, not crash.
2. Restart MongoDB's primary mid-load. Same.
3. Kill a backend mid-transaction (`pg_terminate_backend`). The next caller must
   not inherit the dead connection — this found a real bug once already.
4. Run two app instances at once. Confirm leader-locked jobs run once.
5. Fill the connection pool. Confirm queueing, not deadlock.
6. Run `npm run reconcile:pg` after each. It must come back clean.

Then set `infrastructureTested: true` for what you actually drilled, with the
evidence written into the `evidence` field — and **only** for what you drilled.

### 2.3 Flipping a path

The order is enforced in code; a path refuses to carry authority while anything
it depends on is still on Mongo. Wallet first, KYC last.

For each path, in order:

1. `npm run certify:report` — confirm the path shows no blockers.
2. Reconciliation clean for **24h continuously** in production. Not one green
   run — a day of them.
3. For the merchant wallet only: `npm run reconcile:pg -- --open-merchant-ledgers`
   first. It gives mirrored balances an opening entry, and is idempotent.
4. Set the one env var. Deploy.
5. Watch reconcile and the drift metrics for an hour.
6. **Reverting is redeploying without the variable.** The reverse mirror keeps
   Mongo current the whole time, so nothing is lost either way.

Do one path per week at most. The point of the design is that you never have to
move more than one thing at a time.

### 2.4 What is still unbuilt

Honest list, so nothing here is a surprise later:

- **Routing** for `settlements`, `casino_settlement`, `bonuses_and_commissions`
  — the Postgres modules exist and are tested, but `gameEngine`,
  `settlementService` and `gameProvider.routes` still write Mongo directly.
- **Mirror / reconcile / reverse-mirror legs** for those same three.
- **A cross-store integration suite for bets.** Flagged in the registry as NOT
  WRITTEN. Every other domain that got one found a real bug — including M-6.
- **KYC** — mirrored only, and last in the order by design.

---

## Part 3 — Working with Claude Code on this yourself

You are not a coder, and this codebase is now large enough that the way you ask
matters more than what you ask for.

### What has actually worked here

**Ask for evidence, not assurances.** The single most valuable instruction you
gave was *"never mark an item PASS based only on code inspection."* It is why
M-6 was found — a query that reads as obviously correct, refused by MongoDB only
at execution. Keep saying it.

**Ask "what did you NOT verify?"** at the end of any task. The answer is where
the risk is. If you get "everything passed", ask again more specifically.

**One domain at a time.** Your sequential instruction — ledger, then orders, then
settlement, and so on — is why each piece is reviewable. A request to "finish the
migration" would have produced something nobody could check.

**Make it break its own work.** Every fix here was mutation-tested: change the
code to reintroduce the bug, confirm a test fails, change it back. Ask for that
explicitly — *"prove the test would catch it"* — because a test that passes
against broken code is worse than no test.

### Good prompts for this repo

- "Read `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` and tell me what is blocking
  the *wallet* domain specifically. Do not summarise the others."
- "Run the full test suite and show me the actual output, not a summary."
- "I want to flip `MONEY_AUTHORITY_WALLET`. Walk me through what that changes,
  what breaks if it goes wrong, and how I undo it."
- "Something is wrong in production: [paste the error]. Do not guess — find the
  code path and show me it."

### Things to be wary of

- **A confident answer about something that was not run.** "This should work" is
  not "this works". Ask which command produced the answer.
- **Silent scope reduction.** If you ask for three things and get two, the third
  did not become unnecessary.
- **Changed flags.** `implemented: true` in `moneyAuthority.js` is a claim that
  someone can point at the code, the reconciliation query and the rollback path.
  If one changes, ask what evidence backed it.

### The files that tell you the truth

| File | What it answers |
|---|---|
| `docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` | Generated. What is certified. |
| `docs/MONGO_MONEY_AUDIT.md` | Every known defect and its real status |
| `docs/FINANCIAL_DOMAIN_MATRIX.md` | Per-domain detail (hand-maintained — trust the generated one when they disagree) |
| `backend/postgres/moneyAuthority.js` | The registry itself. The source of truth |

---

## Part 4 — The Android app, later

Two things to settle **before** the app is built, because both are far cheaper
now than after there are installs in the wild:

**1. Send an `Idempotency-Key` header on every money request.** A mobile network
drops and retries constantly — this is exactly the environment where a retried
bet becomes a second bet. The backend already accepts the header. One UUID per
user action, reused if the app retries that same action, new for a new one. This
is the single highest-value thing the app can do for correctness.

**2. Decide the API contract before writing screens.** The panels talk to the
backend over the same REST API the app will use. Fixing a response shape is easy
now and breaking once a version is published.

Also worth planning early: forced-update support (you will need to retire a
version that has a money bug), certificate pinning, and *never* trusting a
client-supplied balance — always re-read from the server after any money action.

When you get there, a good opening prompt is:

> "I'm building an Android app against this backend. Read the route files under
> `backend/domains/` and give me the complete API surface a client needs for:
> auth, wallet, deposit, withdrawal, betting. For each endpoint show the request
> and response shape. Flag anything that needs an Idempotency-Key."
