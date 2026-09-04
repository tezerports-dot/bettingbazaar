# `database/` — the only place this platform talks to storage

PostgreSQL is the only datastore. There is no document store, no mirror, no
dual write, no reverse sync, no authority resolver, no cutover.

## The rule

**Nothing outside this folder writes SQL, opens a connection, or knows a table
name.** The application imports the API and gets a namespaced surface:

```js
import { db } from '#db';

const balances = await db.wallets.getBalances(userId);
const merchant = await db.merchants.getMerchant(merchantId);
const config   = await db.config.getSystemConfig();
```

`#db` is a Node subpath import declared in `package.json`, so it resolves the
same from any depth and does not break when a file moves.

That boundary is the point of the folder, and it is not tidiness. When the
schema, the storage engine or a repository's internals change, the change stops
at `index.js` and every caller keeps working. A folder nothing enforces is a
folder that leaks — one route writes its own query, then five do — so
`npm run check:db-boundary` fails the build on:

1. SQL written outside `database/`
2. the `pg` driver imported outside `database/`
3. `database/` reached by a relative path instead of `#db`

Exemptions are listed in that script by name, each with the reason.

## Layout

| Path | What it is |
|---|---|
| `index.js` | **The API.** The only thing application code imports. |
| `client.js` | The pool, `query`, transactions, `applySchema`. |
| `schema.sql` | Every table, constraint, index and trigger. Applied idempotently on boot. |
| `spec/` | Contracts enforced in code rather than by a constraint — currently the configuration spec. |
| `repositories/` | One module per domain. **The only SQL in the repository.** |
| `migrations/` | Schema changes that cannot be an idempotent `CREATE`. |
| `tests/` | The suites that run against a real PostgreSQL. |
| `moneyPaths.js` | Metric labels for the eleven money domains. |

A repository named `x.core.js` is the mechanism — locking, movement,
transitions. `x.js` is the vocabulary the application speaks. `index.js`
re-exports both under one namespace, because a caller should not have to know
which layer a function came from.

## Money rules that do not bend

1. **Integer paise in `BIGINT`.** Never a float, never a decimal string in
   arithmetic. Rupees are a display conversion at the boundary.
2. **`BIGINT` arrives from node-postgres as a STRING.** Cast where the row is
   read, once. Uncast, `'900' >= 1000` is `true` and every comparison is wrong.
3. **Row-level locking** (`SELECT … FOR UPDATE`) around every balance mutation.
4. **An append-only, double-entry ledger.** A balance never moves unaudited.
5. **`tx_id` UNIQUE is the idempotency gate** — inside the transaction, never a
   pre-read that a concurrent caller can pass simultaneously.
6. **Counters are reconstructed from rows**, never accumulated in memory. An
   accumulator counts passes, not rows, and a crash mid-pass loses the count
   permanently while the money stays correct.
7. **Every balance read is DISPLAY or DECISION.** A display read may be stale; a
   decision read may not, and goes through the wallet under the lock the write
   takes. `npm run check:balance-reads` finds the ones that bypass it.

## Adding a table

1. Add it to `schema.sql` with its constraints. Make an impossible row
   impossible there rather than in a validator a code path can skip.
2. Write or extend a repository in `repositories/`. Keep the SQL there.
3. Export it from `index.js` under the right namespace.
4. Write a test in `tests/` against a real PostgreSQL. Where a boundary carries
   money, test through it — a suite that mocks the settlement writer once
   reported settlement working while the real function threw on every call.

`schema.sql` is applied on every boot, so every statement in it must be
idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and
`ADD CONSTRAINT` wrapped in `DO $ … EXCEPTION WHEN duplicate_object $`.

## Commands

| Command | What it proves |
|---|---|
| `npm run check:db-boundary` | Nothing outside this folder touches the database. |
| `npm run test:pg` | The money paths, against a real PostgreSQL. |
| `npm run check:balance-reads` | No money decision reads a stale copy. |
| `npm run check:no-mongo` | The single-store rule holds. |
