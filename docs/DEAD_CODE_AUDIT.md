# Dead code audit — what was removed, and what only LOOKS dead

**If you are an automated agent about to delete something because nothing
references it: read this file first.** Most of the unreferenced exports in this
repository are unreferenced on purpose, and three of them are called by name by
something outside the codebase. Deleting them breaks things that no test covers.

Audit run 2026-08-11 over all 360 tracked JS files. Method: every
`export function` / `export async function`, checked against every other source
module and separately against the test tree.

    exported and referenced by NO other source module     47
      …of those, referenced by nothing at all             13
      …the rest are referenced only by tests              34

## The measurement was wrong the first time, and that is the point

The first pass listed `connectMongoDB`, `connectRedis` and `seedAdminAccount` as
referenced by **nothing**. All three are called from `backend/server.js`. The
file list came from `git ls-files backend/**/*.js`, and the shell expanded `**`
as a single `*` — so `backend/server.js`, one level down, was never scanned.

Acting on that list would have deleted the database connection.

A reference count is evidence about the corpus you searched, not about the
program. Anything acting on one needs to state what it searched.

## Removed

| What | Where | Why it was safe |
|---|---|---|
| `secureBetPlacement.js` (whole module, 111 lines) | `backend/postgres/` | A reference implementation of the serializable-with-outbox pattern on a **different table set** (`user_wallets` NUMERIC, `financial_ledger`, `operational_bet_outbox`) and a **string-decimal money model** rather than integer paise. Nothing imported it. Its tables never held the balances the dual-write mirror populates, so an authoritative path built on it would have switched to an empty set of balances at cutover. It was a second, plausible-looking money path sitting next to the real one. |
| `_tlsFingerprintDefenseConfig`, `_setTlsFingerprintDefenseConfig` | `backend/middleware/tlsFingerprintDefense.js` | Underscore-prefixed test seams with **no test anywhere**. The sibling middlewares (`ipDefense`, `loadShed`) have the same pair and theirs *are* used, which is what made these look load-bearing. |
| `recordWin` | `backend/postgres/casinoPg.js` | A two-line wrapper: `recordCallback({ ...args, type: CASINO_TX.WIN })`. `casinoPgAuthority` imports `recordCallback` directly. Superseded, not dead-on-arrival. |

## KEPT — and here is why each one is not a bug

### Called by name from outside the codebase

- **`handleSummary`** — `loadtest/bet-contention.js`. **k6 calls this by name.**
  It appears in no import anywhere and never will. Deleting it silently removes
  the load test's output. This is the clearest example of why a reference count
  is not a verdict.

### Scaffolding for capabilities the registry deliberately claims

- **`getService`, `hasService`, `listServices`** — `services/serviceRegistry.js`.
  The *write* side (`registerService`) is called from `server.js:87`. The read
  side is the API surface for CAP-72 (Hybrid Service Topology) and CAP-73
  (Inter-Service Authentication), both `architecture-ready` in
  `platform/capabilities.yaml`. Deleting them would make the registry's own
  claim false, and `npm run verify:capabilities` exists to catch exactly that.
- **`registerProcessor`** — `services/jobQueue.service.js`. Same shape: the
  queue's processor-registration API, unused until a processor is added.

### Halves of a lifecycle whose other half IS used

- **`closeRealtimeBridge`** — `startup/realtimeBridge.js`. `initRealtimeBridge`
  is called at boot; nothing calls the close. That is a **shutdown-path gap, not
  dead code** — the fix is to call it on SIGTERM, not to delete it. Recorded
  here rather than silently removed.

### Read APIs of a domain whose writes are routed

- **`readSettlement`** (`settlementPgAuthority`), **`getUserGrants`**
  (`bonusPg`), **`getAllFlags`** (`featureFlags.service`).
  Each is the read half of a domain that currently only writes. `getUserGrants`
  answers "was this user ever given a signup bonus?", which is the question
  fraud review asks and the reason `bonusPg` keeps clawed-back grants instead of
  deleting them. These become live when an admin surface is built on them.

### The 34 referenced only by tests

Not listed individually. They are overwhelmingly **deliberate seams**:
`_resetPoolMemo`, `_workerPoolState`, `_setIpDefenseConfig`, `getBetHistory`,
`getOrderHistory`, `findOrdersMissingLedgerEvents`, `findOverRefundedRounds`,
`reconcileRound`, `findRejectionsMissingReason`, and similar. They exist so a
test can observe internal state or run a reconciliation check that has no
production caller *yet*. Several of them — the `find…Missing…` family — are
gap-detection queries whose whole value is returning empty in normal operation.

**A check that can only ever return empty is still worth running.** It is the
one that catches a future path added without the guard. Do not delete a
reconciliation query because it never finds anything.

## If you are adding to this audit

State the corpus you searched. Prefer moving something to the "kept, and why"
table over deleting it — a wrong deletion in this repository is a money path or
a safety check, and the tests that would catch it are frequently the very thing
being deleted alongside it.
