# CLAUDE.md — BettingBazaar

**This file outranks every other document in this repository, including
`docs/governance/04-GOVERNANCE.md` and the BBEPS specification it cites.** Where
any document disagrees with this file, this file wins and the other document is
wrong and must be corrected.

---

## The rule

**PostgreSQL is the only datastore. There is no second store.**

This platform stores every piece of state — money, identity, configuration,
content, engagement — in PostgreSQL. There is no document store, no mirror, no
dual write, no reverse sync, no reconciler, no authority resolver, no capability
flag and no cutover. Those things were an abandoned plan. Any document
describing them describes something that no longer exists; correct it or delete
it, do not follow it.

Do not add a second store. Do not add a compatibility shim for one. Do not
reintroduce an ODM. If a piece of code will not work without one, the code has
not been migrated yet — migrate it, do not accommodate it.

### Consequences that follow from the rule

- **A failing test is not a reason to write a document-store fixture.** It means
  the code under test has not been moved to PostgreSQL yet. Move it.
- **Never read a money decision from one store and execute it in another.**
  Affordability, withdrawal admission and merchant assignment all decide with
  money; every one of them reads the same rows it writes.
- **Do not mock the boundary that carries money.** A suite that mocks the
  settlement writer and asserts on its arguments once reported settlement
  working while the real function threw on every call. Where a boundary carries
  money, test through it against a real database.
- **Removal happens in sweeping passes**, with scripts and codemods across the
  whole codebase — not one call site at a time, waiting for CI to say what is
  next.

---

## Exit criteria

The migration is complete when, and only when, all of the following hold. These
are counted mechanically by `npm run check:no-mongo`; the numbers in parentheses
are the baseline measured before removal began.

1. Zero `mongoose.model()` call sites (currently 520 outside tests).
2. Zero files importing `mongoose` or `models/index.js` (currently 100).
3. `mongoose` and `mongodb-memory-server` out of `package.json`; `MONGODB_URI`
   out of every script and env file.
4. The integration test tier gone.
5. Zero MongoDB references in code comments (currently ~600 lines).
6. Zero MongoDB references in `docs/` and governance (currently 24 files).
7. No money decision read from one store and executed in another.
8. `BalanceAdjustment`, `BlockedIP` and `ChatMessage` are referenced through
   `mongoose.model()` in five files and DEFINED NOWHERE — every call throws
   `MissingSchemaError` today, so the admin retention route, the IP-block check
   in `middleware/security.js`, and three chat endpoints are dead. Build them in
   PostgreSQL or delete the routes. `BlockedIP` is a real security control that
   is currently absent — flag that to the owner rather than silently dropping
   it.

### The gate

```
npm run check:no-mongo
```

Non-zero exit with a per-file report while any count is above zero. Run it after
every removal pass; **the numbers must only go down.** It runs in CI and is the
definition of done.

`scripts/verify-no-mongo.mjs` is the only file permitted to name the forbidden
strings, because it is the thing that forbids them. It excludes itself by path.
Nothing else is exempt — not a comment, not a variable name, not a doc.

---

## Do not claim readiness

Until `check:no-mongo` reports zero on every count and the suites run green
against PostgreSQL alone, this platform is not ready to take money. No
individual green check says otherwise. Do not describe the platform as ready,
migrated, or production-capable before then.

---

## What is being kept

The financial core in PostgreSQL is good and stays exactly as it is:

- Integer paise in `BIGINT` — never floats, never a decimal string in arithmetic.
- Row-level wallet locking (`SELECT … FOR UPDATE`) around every balance mutation.
- An append-only, double-entry ledger.
- Unique `tx_id` idempotency gates.
- `*_transitions` audit tables.
- `CHECK` constraints that make an impossible row impossible.

Only the migration scaffolding around that core is being removed. If a change
would weaken any of the six properties above, it is wrong regardless of what
else it achieves.

---

## Traps — already found and paid for. Do not rediscover them.

Each of these cost a CI round trip. They are recorded so the next reader does not
pay again.

1. **`computeWinningsPayout()` has no `payout` key.** It returns
   `{gross, fee, net, …}`. Writing `p?.payout ?? 0` silently pays **zero** while
   still charging the fee. Read `net`.
2. **Take the owner from the row, not the argument.** `settleBetOnPostgres()`
   read `String(bet.userId)` unguarded in two places. Callers enumerating from
   PostgreSQL pass `bet: null`, so it threw on every call.
3. **Something must actually advance the cycle.** Nothing in production advanced
   the PostgreSQL cycle `status` or `winner` — `ensureCycle` created the row at
   `OPEN` and it stayed there, so the engine looked healthy and silently never
   settled. Whatever declares a result **must write the winner BEFORE the
   status**, and a cycle with no winner **must not be offered for settlement**.
4. **Do not store real pool totals on the `cycles` row** — it deadlocks (40P01).
   A bet holds `FOR SHARE` on that row, so a bet that also `UPDATE`s it blocks
   against another bet doing the same. Derive real pools from `bets`; store only
   the phantom figures.
5. **`BIGINT` comes back from node-postgres as a STRING.** Uncast, `'900' >= 1000`
   is `true` and every balance comparison is wrong. Cast at the boundary, once,
   where the row is read.
6. **Reconstruct counters from rows; never accumulate them in memory.** An
   accumulator counts passes, not rows, and a crash mid-pass loses the count
   permanently while the money stays correct.
7. **Classify every balance read as display or decision.** Money decisions read
   from the wrong store were found in three places: bet-placement affordability,
   withdrawal admission (`paymentProcessing.service.js`), and merchant
   assignment (`merchantScoring.service.js`, which filtered candidates by a
   document-store `tokenBalance`). A display read may be stale; a decision read
   may not.
8. **`createWithdrawalOrder` and `selectBestMerchant` decide where a player's
   money goes and had zero tests.** They stay covered.
9. **CI log noise buries the failure.** PostgreSQL logs every refused `ERROR`
   with its full statement, and the concurrency suites provoke those on purpose.
   The runner dumps the whole container log at teardown, pushing vitest output
   and failure annotations out of the retrievable window. Set
   `log_min_error_statement=panic` and `log_min_messages=fatal` at runtime
   before the suites run. A service container has no `command:` key — use
   `ALTER SYSTEM` + `pg_reload_conf()` in a step.

---

## Working rules

- **Read the whole path before changing part of it** — endpoint, service, store
  access and fixtures together. A route rewritten without its service is a bug
  with a green test.
- **Do not accommodate; remove.**
- **Derive, do not duplicate.** One owner per value (`04-GOVERNANCE.md` §1
  still governs this).
- **Money is integer paise, everywhere, in `BIGINT`.**

---

## Commands

| Command | What it proves |
|---|---|
| `npm run check:no-mongo` | The single-store rule holds. **The definition of done.** |
| `npm run test:unit` | Money arithmetic, risk validation, cycle types, SSE, winners. |
| `npm run test:pg` | Money-path behaviour against a real PostgreSQL. |
| `npm run check:deps` | No circular imports, no governance boundary violations. |
| `npm run verify:capabilities` | Every claimed capability has its evidence on disk. |
