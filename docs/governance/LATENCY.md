# Latency — what the code costs, and what is unmeasured

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

**Read this first.** No load test has been run against this platform
(`LAUNCH_READINESS.md` §D). What follows is measured *component* cost plus an
analysis of the request path — it is not a prediction of production latency
under real traffic, and it must not be quoted as one. The numbers below come
from a build container, not production hardware.

---

## Measured on 2026-07-28

Benchmarked directly, not estimated:

| Operation | Cost | Where it runs |
|---|---|---|
| **Argon2id hash + verify** (19 MiB, t=2, p=1) | **~80 ms** (min 72, max 107) | login only |
| **Ed25519 verify** (PASETO v4.public core) | **0.13 ms** | every authenticated request |
| **TOTP verify** (incl. generation) | **0.04 ms** | login, when 2FA is on |

The shape of the system is in those three rows: **authentication is expensive
exactly once, and cheap thereafter.**

---

## Login — dominated by one thing

Argon2 is ~80 ms and everything else on the path is noise beside it. That is
deliberate: it is an OWASP-minimum cost chosen to make offline cracking of a
stolen password hash expensive. Adding TOTP costs **0.04 ms** on top — 2FA is
free in latency terms; it is a UX cost, not a performance one.

The number worth internalising: **Argon2 runs on the libuv threadpool**, which
defaults to **4 threads**. Four concurrent logins saturate it. A fifth waits.

At 80 ms per verify and 4 threads, one instance tops out around
**50 logins/second** — and while those threads are busy, every other user of
the threadpool (file I/O, native crypto) queues behind them. This is the single
most likely source of a bad first impression at launch, because sign-ins cluster
hard: a promotion, a cycle opening, a push notification.

Mitigations, in order of preference:
1. **Raise `UV_THREADPOOL_SIZE`** (e.g. 8–16) — one env var, immediate effect.
2. **Scale horizontally** — logins are stateless; more instances is linear.
3. Lower `ARGON2_MEMORY_KIB` — **last resort**, it directly weakens password
   storage. Do not do this to fix a capacity problem that hardware can fix.

---

## Authenticated requests — cheap

Token verification is 0.13 ms. A normal request's latency is therefore
**dominated by database round trips, not by the app**:

- MongoDB pool: `MONGO_MAX_POOL_SIZE`, default **10** per instance
- Postgres pool: `PG_POOL_SIZE`, default **10** per instance

Those defaults are the ceiling that matters. Ten concurrent in-flight queries
per instance; the eleventh waits for a connection, and that wait appears as
latency with no slow query to blame it on. Watch `bb_pg_pool_connections`
with `state="waiting"` — sustained non-zero is pool exhaustion, and it is the
failure that looks like "the database got slow" when the database is fine.

**Keep `instances × (Mongo pool + PG pool) ≤ the database tier's connection
cap`** (§21). Scaling out without raising the cap moves the bottleneck to the
database's own connection limit, where it is much harder to diagnose.

---

## Bet placement — the hot path

Per placement, on MongoDB (the authoritative store today):
1. `SystemConfig` read — cached
2. Risk assessment — in-process
3. `User` read for the balance split
4. **`findOneAndUpdate`** with `$gte` guards — the atomic debit
5. `Bet.create`
6. `Cycle.findOneAndUpdate` — pool update
7. Ledger rows — fire-and-forget
8. `Transaction.create`

That is **five to six sequential round trips**. On a same-region replica set
(~1–2 ms each) it is single-digit milliseconds of database time; across regions
it degrades linearly and painfully. **Co-locate the app and the database.**

Steps 6 and 8 are the contention point, not step 4: every concurrent bet on the
same cycle updates the *same* `Cycle` document. Under load this serialises on
one document, and no amount of horizontal scaling helps. This is the first thing
a real load test would surface — and the reason a load test is a launch gate
rather than a nice-to-have.

---

## Realtime

- **SSE** — one long-lived connection per client. Cheap per message, but every
  connection holds a socket and file descriptor. Raise `ulimit -n`.
- **socket.io** — WebSocket only (`upgrade: false`), so no polling fallback cost.
- **Redis pub/sub** — fan-out across instances; single-instance deploys skip it.

Realtime connections are a **memory and descriptor** cost, not a CPU one. They
scale with concurrent users, not with request rate.

---

## What is NOT known

Stated plainly, because these are the questions a launch actually turns on:

- **Real p50/p95/p99 under load** — no load test has been run.
- **Where the `Cycle` document contention wall is.** The analysis above says it
  exists; only a test says at what concurrency it bites.
- **Production database latency.** Everything here assumes same-region. A
  cross-region hop multiplies steps 1–8 above.
- **Cold start.** Nixpacks/Railway boot time is unmeasured.
- **Behaviour at the load-shed threshold.** `LOAD_SHED_MAX_INFLIGHT` and
  `LOAD_SHED_MAX_LAG_MS` return 503 past their ceilings; those ceilings have
  never been reached in anger, so the shedding behaviour is untested in practice.

**To get real numbers**: run a load test against staging that ramps concurrent
bets on a single cycle, and watch `http_request_duration_seconds`,
`bb_pg_pool_connections{state="waiting"}` and `bb_requests_shed_total`. Those
three metrics already exist and will answer every question in this section.
