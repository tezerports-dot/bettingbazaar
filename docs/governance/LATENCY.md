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
1. **Raise `UV_THREADPOOL_SIZE`** — one env var, but **benchmark before and
   after; do not assume a value is safe.** Argon2 holds ~19 MiB per concurrent
   job, so 16 threads is ~304 MiB of hashing memory alone, before the
   application, the driver pools and the OS. Raising it past what the instance
   can hold trades queueing for CPU contention or an OOM kill, which is a worse
   failure than a slow login. Size it against the instance's actual memory and
   cores.
2. **Scale horizontally** — logins are stateless; more instances is linear.
3. Lower `ARGON2_MEMORY_KIB` — **last resort**, it directly weakens password
   storage. Do not do this to fix a capacity problem that hardware can fix.

---

## Authenticated requests — cheap

Token verification is 0.13 ms. A normal request's latency is therefore
**dominated by database round trips, not by the app**:

- Postgres pool: `PG_POOL_SIZE`, default **10** per instance

**One pool, one ceiling.** Earlier revisions tracked two independent pools
against two databases, and warned that a wait in one was invisible in the
other's metric. That ambiguity is gone: there is one pool, so a query that waits
waits here, and `bb_pg_pool_connections{state="waiting"}` sees every such wait.
Sustained non-zero means the pool is the bottleneck.

Size it against the database's own cap:

- `instances × PG_POOL_SIZE ≤ the PostgreSQL tier's `max_connections`` (minus
  what admin tooling and replication reserve — leave headroom or a routine
  `psql` session is what tips it over)

Scaling out without raising the cap moves the bottleneck into the database's own
connection limit, where it is much harder to diagnose. **PgBouncer in transaction
mode is safe here** — the app takes no session-scoped advisory locks.

---

## Bet placement — the hot path

Per placement:
1. `SystemConfig` read — cached
2. Risk assessment — in-process
3. **One transaction**, holding the wallet row lock throughout:
   - `SELECT … FOR UPDATE` on the wallet row — the balance read the debit is
     decided from, taken under the lock rather than before it
   - the debit, guarded by a non-negative `CHECK`
   - the `bets` row insert
   - the ledger rows, with their unique `tx_id`
   - `SELECT … FOR SHARE` on the cycle row — the open-gate check
4. Realtime notify, projections, stats — fire-and-forget, off the request

That is **one round trip that matters**, not five or six sequential ones: the
whole money movement commits together. Co-located, it is low single-digit
milliseconds; across regions it degrades linearly and painfully. **Co-locate the
app and the database.**

**The contention point is the wallet row lock**, and it is per-user, so distinct
bettors do not queue behind each other. Two things to know about it:

- **The split is computed inside the lock**, never from a pre-read. A spend order
  draws deposit first and lets winnings cover the shortfall, so the split depends
  on the balances; computing it from an unlocked read makes a replay able to
  compute a *different* split, miss the unique-`tx_id` collision, and debit
  twice.
- **The cycle row is `FOR SHARE`, never updated.** Real pool totals are derived
  from `bets`. A bet that also updated the cycle row would deadlock (40P01)
  against another bet doing the same — which is why the old per-bet counter
  update, the previous ceiling described here, is gone rather than optimised.

Where the remaining ceiling sits is unmeasured, which is precisely why a load
test is a launch gate rather than a nice-to-have.

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
  cross-region hop adds its higher round-trip time to EACH of the sequential
  calls above — additive per round trip, so the total grows with how many the
  path makes, not as a multiplier on the whole request.
- **Cold start.** Nixpacks/Railway boot time is unmeasured.
- **Behaviour at the load-shed threshold.** `LOAD_SHED_MAX_INFLIGHT` and
  `LOAD_SHED_MAX_LAG_MS` return 503 past their ceilings; those ceilings have
  never been reached in anger, so the shedding behaviour is untested in practice.

**To get real numbers**: run a load test against staging that ramps concurrent
bets on a single cycle, and watch `http_request_duration_seconds`,
`bb_pg_pool_connections{state="waiting"}` and `bb_requests_shed_total`.

Those three already exist and answer **several** of the questions above —
request-latency distribution, Postgres pool pressure, and whether shedding
engages. They do **not** answer the rest: cold start, production network and
database latency, or where the wallet row-lock contention wall sits. Those need,
respectively, a boot-time measurement, production-side database metrics, and a
test that ramps concurrency against ONE user's wallet while watching lock-wait
time — plus a `pg_stat_database.deadlocks` alert, since any deadlock at all is a
bug rather than a ceiling.
