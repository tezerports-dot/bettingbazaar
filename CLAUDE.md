# BettingBazaar — the standing rule

## PostgreSQL is the only database. MongoDB is being deleted.

Not migrated, not mirrored, not kept in sync. **Deleted.** There is no
production deployment, no live data and no cutover to protect, so there is
nothing to preserve and no reason to build machinery that preserves it.

This rule outranks every other document in this repository, including
`docs/governance/04-GOVERNANCE.md` and anything under `docs/` that describes a
two-store architecture, a dual-write, a reverse mirror, a reconciler, an
authority resolver, a capability flag, or a cutover. Those documents describe a
plan that has been abandoned. Where one of them conflicts with this file, this
file wins and the other document is wrong and should be corrected or removed.

## Done means

1. Zero `mongoose.model()` call sites.
2. Zero files importing `mongoose` or `models/index.js`. `backend/models/` and
   all 59 schemas deleted.
3. `mongoose` and `mongodb-memory-server` out of `package.json`; `MONGODB_URI`
   out of every script and every environment file.
4. The integration test tier gone, or running with no MongoDB present.
5. Zero MongoDB references in code comments. A comment describing a store that
   does not exist is a false map.
6. Zero MongoDB references in `docs/` and in governance.
7. No money decision read from one store and executed in another.
8. The three models that are referenced but never defined
   (`BalanceAdjustment`, `BlockedIP`, `ChatMessage`) either built in PostgreSQL
   or their routes deleted.

## Working rules

**Do not accommodate MongoDB. Remove it.** If a test needs a Mongo fixture to
pass, the answer is to move the code under test off Mongo — not to build a
better fixture. Fixtures that fund a Mongo document so a PostgreSQL path will
accept it (`bettable`, `funded`, `fundedMerchant` in
`backend/tests/integration/_fixtures.js`) are TRANSITIONAL SCAFFOLDING and are
deleted with the tier they serve. Do not add more.

**Do not mock the thing that breaks.** A suite that mocks
`settleBetOnPostgres` and asserts on its arguments proved settlement worked
while the real function threw on every call. Where a boundary carries money,
test through it against a real database.

**Read the whole path before changing part of it.** Three separate faults were
found in one endpoint, one CI round trip at a time, because each fix looked at
only what was blocking. Read the endpoint, its service, its store access and
its fixtures together.

**Do not claim readiness.** Until the eight criteria above hold and the suites
run green against PostgreSQL alone, this platform is not ready to take money.
No individual green check says otherwise.

## Architecture, once this is done

CDN and WAF in front · Node/Express modular monolith · **PostgreSQL** for all
durable truth · **Redis** for cache, realtime fan-out, rate limits and job
queues. Wallets, ledger, bets, payments, settlements and auth security state
are PostgreSQL and nowhere else.
