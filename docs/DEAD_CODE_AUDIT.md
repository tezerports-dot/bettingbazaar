# Dead code audit — what was removed, and what only LOOKS dead

**If you are an automated agent about to delete something because nothing
references it: read this file first.** Most of the unreferenced exports in this
repository are unreferenced on purpose, and three of them are called by name by
something outside the codebase. Deleting them breaks things that no test covers.

**How this file is maintained:** it describes the codebase as it is NOW, not a
history of clean-ups. There is one list of what has been removed and one list of
what only looks removable. When something is removed, add a row — do not append
a new dated section, because the reader needs "what is true today", and a pile
of dated sections makes them reconstruct it.

Last full scan: 2026-08-11 over all 360 tracked JS files — every
`export function` / `export async function`, checked against every other source
module and separately against the test tree. Removals since then are recorded
below as they happen.

    exported and referenced by NO other source module     47
      …of those, referenced by nothing at all             13
      …the rest are referenced only by tests              34

## The measurement was wrong the first time, and that is the point

The first pass listed the database connector, `connectRedis` and `seedAdminAccount` as
referenced by **nothing**. All three are called from `backend/server.js`. The
file list came from `git ls-files backend/**/*.js`, and the shell expanded `**`
as a single `*` — so `backend/server.js`, one level down, was never scanned.

Acting on that list would have deleted the database connection.

A reference count is evidence about the corpus you searched, not about the
program. Anything acting on one needs to state what it searched.

## Removed — and must not come back

| What | Where | Why it was safe, and why it stays gone |
|---|---|---|
| `secureBetPlacement.js` (whole module, 111 lines) | `backend/postgres/` | A reference implementation of the serializable-with-outbox pattern on a **different table set** (`user_wallets` NUMERIC, `financial_ledger`, `operational_bet_outbox`) and a **string-decimal money model** rather than integer paise. Nothing imported it. Its tables never held the balances the dual-write mirror populates, so an authoritative path built on it would have switched to an empty set of balances at cutover. It was a second, plausible-looking money path sitting next to the real one. |
| `_tlsFingerprintDefenseConfig`, `_setTlsFingerprintDefenseConfig` | `backend/middleware/tlsFingerprintDefense.js` | Underscore-prefixed test seams with **no test anywhere**. The sibling middlewares (`ipDefense`, `loadShed`) have the same pair and theirs *are* used, which is what made these look load-bearing. |
| `recordWin` | `backend/postgres/casinoPg.js` | A two-line wrapper: `recordCallback({ ...args, type: CASINO_TX.WIN })`. `casinoPgAuthority` imports `recordCallback` directly. Superseded, not dead-on-arrival. |

| `generateKYCUploadUrl` | `backend/services/cdn.service.js` | Minted a **writable** S3 URL under a `kyc/` prefix. Its route and service were removed 2026-08-25; this survived with no caller, which is exactly what made it dangerous — an unused working tool for collecting identity documents is how document collection returns without a decision being taken. The platform collects a 12-digit Aadhaar NUMBER and nothing else. Constraints for any future proposal: `IDENTITY_AND_REFERRALS.md` §6a. |
| `generateDisputeUploadUrl`, `generateProfilePictureUploadUrl`, `generatePromoUploadUrl` | `backend/services/cdn.service.js` | No caller anywhere in the repo — the live routes call `generatePresignedUploadUrl` directly. **Note the trap:** all four were still listed in the file's `export default` after their definitions went, which is a ReferenceError at module load in a file every upload route imports. Removing a function means removing it from the barrel too. |
| `User.email`, the `EMAIL` communication channel, `nodemailer`, `SMTP_*` | `user.model.js`, `communication/channelRegistry.js`, `package.json` | The bot never asks for an email, so the field was empty for every player who could exist and the adapter's only reachable answer was "user has no email on file". Removed the dependency and the production credentials with it. `SupportLinks.email` and `Merchant.email` are different things and remain. |


## Also removed: whole files and directories

Not "looks unused" — provably not built or served:

- **`*/frontend-handoff/` (189 files) + `scripts/create-frontend-handoffs.mjs` +
  the `handoff:frontends` npm script.** Auto-generated standalone snapshots of
  each panel, never built or served; they existed only to be copied out, and
  produced Dependabot alerts against dead code. Regeneration is no longer wired.
- **`backend/package.json` (+ its already-untracked lockfile).** The backend has
  never been installed on its own — the Docker image runs `npm ci` at `/app`
  from the ROOT lockfile (which carries every backend dep), and `backend/*.js`
  resolve ESM via the root's `"type":"module"`. The stray manifest was a second,
  drifting dependency source (two copies of the same package at different majors).
- **`docs/NEXT_SESSION_HANDOFF.md`** — a transient AI-session handoff pinned to a
  merged PR (#121) and a deleted branch. Superseded by `docs/GO_LIVE_RUNBOOK.md`.
- **`docs/RAILWAY_STAGING.md`** — Railway is off-plan; the platform now self-hosts
  on a Shinjiru dedicated box (`deploy/VPS_UBUNTU_SETUP.md`).

NOT removed (and why the warning at the top of this file still holds): backend
source modules flagged as "unreferenced" by a static scan were left alone — some
are called by name from outside the codebase, and this is a money platform where
a wrong deletion is not caught by any test.


---

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
