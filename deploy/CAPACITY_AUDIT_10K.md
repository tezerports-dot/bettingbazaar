# Production capacity audit — 10,000 DAU, from the code

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Grounded in the actual repository, not generic DAU→server ratios. Every load-bearing
claim cites `file:line`. Anything the code cannot answer is marked
**UNKNOWN — requires load testing**; no benchmark is invented. Companion to
`CAPACITY_PLANNING.md` (the optimizations) and `VPS_UBUNTU_SETUP.md` (the build).

Currency: **₹15,000/mo ≈ RM 790** (1 MYR ≈ ₹19); Shinjiru KVM regular monthly prices.

---

## 0. Three findings that decide the whole audit

1. **DAU ≠ concurrent.** 10,000 DAU is not 10,000 sockets. This app is session-based
   betting on 30-minute cycles, so concurrency is a fraction of DAU that spikes at
   cycle close. The exact fraction is **UNKNOWN — requires load testing / analytics**;
   this audit sizes for a **peak of 500–1,500 concurrent connected clients** (5–15 % of
   DAU), and every table below is parameterised on that number so you can re-read it
   once you measure.

2. **The realtime layer is a GLOBAL broadcast, not per-watcher.** There is **no
   per-event room**. A connecting client joins only `user-<id>` / `merchant-<id>` /
   `admin-room` (`startup/socketHandlers.js:159-200`), and every pool update is
   `global.io.emit('bet_placed', …)` — sent to **every connected socket**
   (`bet.routes.js:422`, `:560`; `cycleGenerator.service.js:175`). So the premise
   "users only receive updates for events they are watching" is **not implemented**.
   Outbound load is `N_connected × bet_rate`, and that — not CPU or RAM — is the first
   ceiling. It is an **architecture** fix (scope emits to per-cycle rooms), not a
   hardware one.

3. **There are only ever TWO live cycles** — one `30_MIN`, one `FULL_DAY`
   (`cycle.model.js:8`), so there is no per-event fan-out explosion. Combined with #2,
   the realtime load is bounded and computable: two event streams, broadcast to all.

The good news in #2/#3: because the load is global-but-bounded, a single realtime
process on a small VPS is enough for 10k DAU **today**, and the cheap win (room-scoping)
is what unlocks the next 10×.

---

## 1. Application load audit

**Runtime shape.** No `cluster` module anywhere (grep: none) — one Node **process per
role**, three roles (`api`, `realtime`, `scheduler`) via PM2
(`VPS_UBUNTU_SETUP.md:302-327`, `backend/startup/runtimeRole.js`). CPU work that would
block the loop is offloaded: CSV to a worker-thread pool
(`services/workerPool.service.js`, `services/cpuWorker.js`), Argon2 to the libuv
threadpool (native module, `domains/identity/password.util.js:8`).

**Per user action (the hot path — placing a bet), `bet.routes.js`:**
| Work | Where | Store |
|---|---|---|
| auth (token verify, no hash) | `auth.middleware.js:85` `verifyJwt` | CPU only |
| token-revocation check | `auth.middleware.js:59` `TokenBlacklist.findOne({token})` | **Mongo read / request** |
| funding read + debit | wallet authority | Mongo (+PG mirror pre-flip) |
| bet insert | `bet.routes.js:236` | Mongo (+PG mirror) |
| cycle open-gate + pool | `bet.routes.js:281` (stored) or `:274` (derived) | Mongo |
| transaction log | `bet.routes.js:351` | Mongo |
| broadcast | `bet.routes.js:419-422` SSE + `io.emit` | Redis pub + N sockets |
| rate limit | `security.js:170` `betLimiter` | Redis |

So one bet ≈ **4–6 Mongo ops, 1 PG-mirror (fire-and-forget), 2 Redis ops (limit + adapter
publish), 1 global broadcast**. Reads dominate elsewhere (snapshots, history, balance).

**RPS / writes / queries per request:** the per-request store-op counts are cited above;
**absolute RPS at 10k DAU is UNKNOWN — requires load testing** (it depends on
bets/user/day and session overlap, neither of which the code fixes). A defensible
planning band, consistent with the app's own docs: **normal ~50–100 API RPS, peak
~200–400** near cycle close, **peak ~10–40 bet-writes/sec** (`CAPACITY_PLANNING.md`).

**Realtime message math (derivable):**
- Public payloads are small: `bet_placed` = 5 fields
  (`bet.routes.js:405-411`), ≈ 120–160 B JSON, ≈ **~200 B on the wire** with Socket.IO
  framing. `cycle_snapshot` ≈ 13 fields (`cycleGenerator.service.js:813-832`), ≈ 350 B.
- **Serialization is done once per emit**, not per client: room/global emits go through
  Socket.IO's encoder which caches the frame (`io.emit`/`io.to(room).emit`); the only
  per-recipient loop is the unique-payout path (`realtimeEmitters.js:80-85`), which is
  correct because each payout differs.
- **Outbound msgs/sec = bet_rate × N_connected** (global broadcast). See §4 for the
  bandwidth table.
- **Inbound** WS messages are negligible: clients send occasional `request_*` and
  `join_*` events (`socketHandlers.js:107-200`), not a stream.

**Static assets:** the `api` role serves the three SPA bundles from disk
(`VPS_UBUNTU_SETUP.md:212-224`); uploads bypass the app entirely via presigned S3 PUTs
(`routes/upload.routes.js`, `services/kycDocuments.service.js`). Put the bundles behind
Cloudflare cache and this load leaves the origin (`CAPACITY_PLANNING.md` §1.6).

**Top CPU-heavy operations** (by inspection; magnitudes **UNKNOWN — requires load
testing**):
1. Argon2id hash/verify — login/register/password-change only (`password.util.js:31,43`).
2. CSV report generation — already offloaded to worker threads
   (`workerPool.service.js`, `reporting.admin.routes.js:13`).
3. Socket.IO frame encoding for global broadcasts (`bet.routes.js:422`).
4. Settlement payout pass over a cycle's bets (`gameEngine.processPayoutsOptimized`).
5. Mongo aggregation for derived pools (`cyclePool.service.js:103-110`) — once/refresh.
6. JSON serialization of snapshots/history on connect (`socketHandlers.js:103`).
7. TLS termination (offloaded to Caddy/Cloudflare, not Node).
8–10. **UNKNOWN — requires load testing** (nothing else in the code stands out as hot).

**Event-loop-blocking risks:** Argon2 and CSV are the two real ones, and **both are
already off the main loop** (libuv threadpool; worker threads). No synchronous crypto,
`JSON.parse` of huge bodies (body cap 1 MB, `server.js:195`), or sync fs on the hot path
was found.

**Top memory-heavy:** Argon2 (19 MiB/concurrent hash, §2); the mongodump backup buffer
(`backup.service.js`); worker-thread pool. Everything else is small.

---

## 2. Authentication / Argon2

Exact config — `domains/identity/password.util.js:23-26`:
| Param | Value | Env override |
|---|---|---|
| variant | **argon2id** | — |
| memoryCost | **19456 KiB (19 MiB)** | `ARGON2_MEMORY_KIB` |
| timeCost (iterations) | **2** | `ARGON2_TIME_COST` |
| parallelism | **1** | `ARGON2_PARALLELISM` |

OWASP minimum (`password.util.js:7`). Native module on the **libuv threadpool**
(`password.util.js:8`), so concurrency is bounded by `UV_THREADPOOL_SIZE` (default **4**;
repo recommends **8**, `VPS_UBUNTU_SETUP.md:274,288`). **Memory per concurrent hash =
19 MiB**; at threadpool 8, worst-case ~**152 MiB** of hashing memory.

**Per-hash wall time is UNKNOWN — requires load testing.** The repo's own estimate is
**~80 ms**, giving **~50 logins/sec per process** at threadpool 4
(`VPS_UBUNTU_SETUP.md:288`); `LATENCY.md:45` explicitly says
benchmark before trusting it. Using that estimate:

| Scenario | Rate | Vs ~50/s/proc ceiling |
|---|---|---|
| A) normal | a few/min | trivial |
| B) 500 logins / 1 min | ~8.3/s | fine |
| C) 1,000 / 1 min | ~16.7/s | fine |
| D) **3,000 / 1 min** | **~50/s** | **saturates one process** |

Argon2 runs **only** at login/register/password-change — an authenticated request
verifies a PASETO token, not a hash (`auth.middleware.js:85`), so **betting/odds traffic
does not touch Argon2** and a login storm cannot directly stall the realtime path *if the
`api` role is a separate process* (which PM2 provides). The auth endpoints are also
already rate-shaped (`security.js:17` `authLimiter`, `:184` unauth-IP, Turnstile
`middleware/captcha.js`), so a true 3,000/min storm is throttled, not unbounded.

**Cheapest safe mitigation:** `UV_THREADPOOL_SIZE=8` (one env var, ~+114 MiB RAM budget)
→ ~100 logins/s/proc, and keep `api` on its own PM2 process. No new hardware. Do **not**
lower the Argon2 parameters (that is a security regression, not an optimization).

---

## 3. Node.js capacity

- **Processes:** one per role (`api`/`realtime`/`scheduler`), no clustering, no per-role
  fork pool (`VPS_UBUNTU_SETUP.md:315-327`).
- **Worker threads:** a CPU pool for CSV only (`workerPool.service.js`); Argon2 uses the
  libuv threadpool.
- **Timers:** `gameEngine` tick every 1 s — a **settlement poll**, not a broadcast
  (`gameEngine.js:38,126-135` — it only looks for `RESULT_DECLARED` cycles to settle);
  payout-recovery every 5 min (`gameEngine.js:40`); `cycleGenerator` manage-cycles every
  1 s (`cycleGenerator.service.js:117`, emits only on phase change).
- **Queues/workers:** BullMQ worker (`jobQueue.service.js:39`) + the reconcile/settlement
  paths run off the request.

**Per-process ceilings (API RPS, WS connections, realtime msgs/s): UNKNOWN — requires
load testing.** The code fixes only the login ceiling (~50/s/proc, repo estimate, §2).
`loadtest/bet-contention.js` and `loadtest/seed-accounts.mjs` exist to measure the rest;
`LATENCY.md` is the repo's ceiling register. I will not substitute a generic Node
benchmark for a measurement this codebase has not taken.

What the code *does* tell us: the `api` process is **I/O-bound** (Mongo/PG/Redis awaits),
not CPU-bound, on the hot path, because the two CPU sinks are off-loop. So one modern
vCPU-pair should carry the planning-band RPS — but the **number is a load-test output**.

---

## 4. Socket.IO / realtime

- **Namespaces:** none (default `/`). **Transports:** WebSocket only, no polling
  (`server.js:157`). **Redis adapter:** `@socket.io/redis-adapter`
  (`startup/realtimeBridge.js:25,46`) — cross-node fan-out for `io.emit`/`io.to(room)`.
- **Rooms:** `user-<id>`, `merchant-<id>`, `admin-room` only
  (`socketHandlers.js:165,181,196`). **No per-cycle/per-event room.**
- **Fan-out:** public updates are **global** (`bet.routes.js:422`,
  `cycleGenerator.service.js:175`); only balance/payout/order and admin payloads are
  scoped (`realtimeEmitters.js:47,85,120`; `cycleGenerator.service.js:180,185`).
- **Generated once, reused:** yes — one encode per emit (Socket.IO encoder); per-socket
  looping happens only for unique payouts (`realtimeEmitters.js:80-85`).
- **Max watchers/event:** = N_connected, because every client receives every cycle's
  updates (global). **Not** a subset.

**Outbound bandwidth** = `bet_rate × N_connected × ~200 B`. With bet_rate a planning
assumption (peak 10–40/s, **UNKNOWN exact**):

| N connected | @ 20 bets/s | @ 40 bets/s |
|---|---|---|
| 100 | 2k msg/s · ~3 Mbps | 4k · ~6 Mbps |
| 500 | 10k · ~16 Mbps | 20k · ~32 Mbps |
| 1,000 | 20k · ~32 Mbps | 40k · ~64 Mbps |
| 2,000 | 40k · ~64 Mbps | 80k · ~128 Mbps |
| 5,000 | 100k · ~160 Mbps | 200k · ~320 Mbps |
| 10,000 | 200k · ~320 Mbps | 400k · ~640 Mbps |

**Monthly (GB):** at the **10k-DAU planning point (≤1,500 concurrent, 20 bets/s peak,
lower average)**, sustained realtime egress is on the order of **~5–15 Mbps average →
~1.5–5 TB/month**, dominated by the global broadcast. Exact average **UNKNOWN — requires
load testing**; peak from the table.

**Is one realtime process enough for 10k DAU?** **Yes at ≤~1,500 concurrent** — ~32 Mbps
and ~20–40k msg/s is within a single process + Redis-adapter reach on a small VPS. It
stops being enough when N_connected grows (5k+ → 160+ Mbps of *global* fan-out), and the
fix is **room-scoping the emits** (send `bet_placed` to a `cycle-<id>` room the client
joins) before adding realtime nodes. That change alone divides the fan-out by the number
of cycles a user is *not* watching. **This is the first architectural bottleneck.**

---

## 5. MongoDB

Models on the money/bet path: `Cycle` (`cycle.model.js`), `Bet` (`bet.model.js`),
`User`/wallet, `Transaction`, KYC, plus the reverse-mirror targets.

- **Hot document: the `Cycle`.** Two live docs (one per type). Every real bet does
  `Cycle.findOneAndUpdate({cycleId}, {$inc:{realDelhi,totalDelhi}})`
  (`bet.routes.js:281`), and **same-document `$inc`es serialize** (WiredTiger is
  doc-level). This is the documented ceiling (`LATENCY.md`) and the reason
  `FLAGS.DERIVED_CYCLE_POOLS` exists (`cyclePool.service.js`) — it removes the contention
  by summing bets instead. **Ops/sec against a Cycle doc = the per-cycle bet rate**
  (peak 10–40/s across two cycles); whether that serializes into a latency problem at
  10k DAU is **UNKNOWN — requires load testing** (`loadtest/bet-contention.js` is exactly
  this measurement). **Schema redesign materially helps: yes** — and it is already built,
  flag-gated (see `CAPACITY_PLANNING.md` §1.2).
- **Indexes:** `Bet` — `{cycleId,status,side,isPhantom}` and `{userId,timestamp}`
  (`bet.model.js:39-40`); `Cycle` — `cycleId` unique, `{type,startTime}` unique, `status`
  (`cycle.model.js:5,76,18`). The hot bet-path reads/writes are covered.
- **Transactions:** money writes use Mongo sessions (replica set **required, even
  single-node** — `VPS_UBUNTU_SETUP.md:82,120`).
- **Pre-flip reality:** Mongo is authoritative for money until the cutover
  (`MONEY_AUTHORITY_*` unset), so it carries wallet/ledger/settlement writes **plus** the
  PG mirror runs — do not size it as "metadata only" (`CAPACITY_PLANNING.md` §0).
- **Settlement:** rare and batched — one pass per cycle, ~**49 cycles/day** (48×30-min +
  1 full-day; cycle length is `SystemConfig.cycleDurationMinutes`, must divide 60,
  `cycleGenerator.service.js:85-94`).
- **CPU/RAM for 10k DAU:** working set is small (2 active cycles, recent bets, users).
  Estimate **2 vCPU / 2–4 GB** — but the exact figure is **UNKNOWN — requires load
  testing**; watch Cycle write-lock % and `findOneAndUpdate` p95, not RAM.

---

## 6. PostgreSQL

- **Pool:** `max = PG_POOL_SIZE || 10` **per process** (`postgres/pgClient.js:59`), single
  `DATABASE_URL` (`pgClient.js`, `VPS_UBUNTU_SETUP.md:151-155`).
- **Locking:** row-level `FOR UPDATE` inside transactions; **no session-scoped advisory
  locks** (verified — grep found none in app code), so **PgBouncer transaction mode is
  safe**.
- **Writes:** wallet ledger (double-entry, append-only, conserve-to-zero triggers), bet
  lifecycle, settlements, orders, KYC — all mirrored today, authoritative after the flip.

**Worst-case connections** (all three roles hold a full pool):
| App processes | Connections | Vs default `max_connections=100` |
|---|---|---|
| 1 | 10 | fine |
| 2 | 20 | fine |
| 3 | 30 | fine |
| 5 | 50 | fine |
| (3 roles × 2 nodes) 6 | 60 | fine, getting close |
| (3 roles × 3 nodes) 9 | 90 | **at the wall** |

**Is PgBouncer needed at 10k DAU?** **No, not strictly** — the minimal (1 app node = 3
processes = 30 conns) and recommended (2 nodes = 60) architectures fit under
`max_connections=100`. PgBouncer becomes **required at the 3rd app node** (~90 conns) and
is **cheap insurance** worth adding earlier. So for the ₹15k/10k target it is
**optional**, not mandatory — do not overbuild it in on day one.

**CPU/RAM/IO:** the transactional workload is light at 10k DAU (peak ~20–40 money-txn/s,
`CAPACITY_PLANNING.md` §1.2 reduction). **2 vCPU / 2–4 GB / NVMe** is a reasonable start;
exact figure **UNKNOWN — requires load testing**. **Top-10 most expensive queries:
UNKNOWN — requires load testing** (`pg_stat_statements` will name them; the code does not
rank them, and I will not guess an order).

---

## 7. Redis

Every Redis use, by class:
| Class | Evidence |
|---|---|
| Socket.IO pub/sub (cross-node fan-out) | `startup/realtimeBridge.js:46` |
| Rate limiting (8 limiters) | `middleware/security.js:17,59,100,135,170,184,199,214` |
| IP defense (subnet limiter) | `middleware/ipDefense.js:111` |
| Scheduler leader lock | `services/jobQueue.service.js` (`withLeaderLock`) |
| Queues (BullMQ) | `services/jobQueue.service.js:39` |
| Cache | `services/CacheService`, `financial_stats` (`gameEngine.js:556`) |

- **Commands/sec** ≈ (rate-limited requests × ~1–2 ops) + (global emits × 1 adapter
  publish) + (leader-lock heartbeats) + cache. At the planning band this is **low
  thousands/sec** — trivial for Redis. Exact: **UNKNOWN — requires load testing**.
- **Pub/sub messages/sec** = global-emit rate ≈ bet_rate (10–40/s) fanned by the adapter.
- **Memory:** counters + session cache + 2 cycles + BullMQ = **small, ~256–512 MB**.
  Exact **UNKNOWN — requires load testing**.

**Can Redis share a VPS with MongoDB at 10k DAU?** **Yes** — both have a small footprint
at this scale. Caveat: Redis is **realtime-critical** (it is the Socket.IO fan-out bus
*and* the leader lock *and* the rate-limit store), so co-locating it with Mongo means a
Mongo spike can degrade all three. Acceptable at 10k; **give Redis its own instance by
~25k** (`CAPACITY_PLANNING.md` §1.4).

---

## 8. Scheduler / workers

- **The `scheduler` role is a singleton** — the game-cycle producer + cron. Exactly one
  active process, Redis-leader-locked (`VPS_UBUNTU_SETUP.md:329-331`,
  `jobQueue.service.js` `withLeaderLock`). Its load is **independent of DAU** (it ticks
  cycles whether 10 or 10,000 watch).
- **Duplicate-work safety:** the leader lock means a second instance is a hot standby, not
  a double-runner (`jobQueue.service.js:88`).
- **CPU/RAM:** low and flat — 1-second timers doing small queries
  (`cycleGenerator.service.js:117`, `gameEngine.js:38`), settlement once per cycle.
- **Needs a separate server?** **No.** It co-locates fine; it needs **≥2 nodes only for
  leader-lock failover**, not for capacity. Never scale it to N active instances.

---

## 9. Storage growth

Driven by bet volume, which is **UNKNOWN — requires load testing / analytics**. Using a
planning assumption of **~50,000 bets/day** at 10k DAU (≈5 bets/DAU):

| Store | Per-row | /day | 3 mo | 6 mo | 12 mo |
|---|---|---|---|---|---|
| Mongo `Bet` (+idx) | ~300–400 B | ~15–20 MB | ~1.5 GB | ~3 GB | ~6 GB |
| Mongo `Transaction` | ~300 B | ~15 MB | ~1.4 GB | ~2.7 GB | ~5.5 GB |
| PG ledger (2–4 rows/bet) | ~200 B | ~20–40 MB | ~2–4 GB | ~4–7 GB | ~8–14 GB |
| Mongo `Cycle` | tiny | 49 docs | negligible | | |
| Redis | working set | flat | ~0.5 GB | | |
| Logs | **UNKNOWN** | — | — | — | — |

So **order 20–40 GB of database growth in year one** at the assumed volume — comfortably
inside a 100–200 GB NVMe. Re-scale linearly with your real bets/day. Backups: daily
`mongodump → gzip → S3` (`services/backup.service.js`); **enable PG WAL/pg_dump off-box
separately** (`VPS_UBUNTU_SETUP.md:490-495`) — same-disk is not a backup.

---

## 10. Network

- **Realtime egress dominates** (§4): peak from the table; average **~5–15 Mbps →
  ~1.5–5 TB/mo** at the 10k planning point, **UNKNOWN exact**.
- **API:** small JSON; a fraction of realtime.
- **Static:** offload to Cloudflare cache → ~0 from origin (`CAPACITY_PLANNING.md` §1.6).
- **DB replication:** none required at this scale (single-node RS, no PG replica needed
  for 10k — a replica is for read-scaling/reporting later, `CAPACITY_PLANNING.md` §3).
- **Backups:** one compressed archive/day to S3.

**Shinjiru KVM includes 100 Mbps + 1 Gbps DDoS** (their page). 100 Mbps comfortably
covers the ≤1,500-concurrent planning point; the table shows you cross 100 Mbps only in
the **global-broadcast** regime at ~3,000–5,000 concurrent — i.e., room-scoping (§4) is
what keeps you inside the included bandwidth as you grow.

---

## 11. Failure / safety — minimum to avoid catastrophe

| Tier | What | Why |
|---|---|---|
| **A — required for function** | 1 VPS: Node (3 roles) + Mongo (single-node RS) + PG + Redis + S3/MinIO + TLS | The boot gate refuses to start without all of these (`VPS_UBUNTU_SETUP.md:20-45`); money txns need the RS; login needs TLS |
| **B — required for performance** | `UV_THREADPOOL_SIZE=8`; derived-pools flag after its load test; Cloudflare static cache; `TRUST_PROXY` correct | §2, §5, §1; wrong `TRUST_PROXY` pools every rate limit across all users (`VPS_UBUNTU_SETUP.md:41-44`) |
| **C — required for HA** | 2nd app node (leader-lock failover for the scheduler + no single app failure domain); off-box backups; PG replica | §8; one box is one failure domain (`VPS_UBUNTU_SETUP.md:487-495`) |
| **D — optional** | PgBouncer (until 3rd node), separate Redis (until ~25k), separate edge VPS | §6, §7, below |

Do **not** add Kubernetes (nothing here needs orchestration), Kafka (Redis pub/sub +
BullMQ are not demonstrably insufficient at 10k — §7), or dedicated servers (VPS capacity
is not demonstrably exceeded). None are justified by this codebase at 10k DAU.

---

## 12. Cheapest architecture within ₹15,000/mo

Shinjiru KVM regular monthly: 4 vCPU/4 GB **RM 109.90 (≈₹2,090)**, 8/8 **RM 182.90
(≈₹3,475)**, 10/10 **RM 272.90 (≈₹5,185)**. **Edge:** prefer **Cloudflare Tunnel
(`cloudflared` on the origin)** — free, and the origin still exposes no inbound port — over
a separate edge VPS, unless you specifically want the disposable-edge posture of
`EDGE_ORIGIN_HARDENING.md` (then add one 4/4).

### A) Absolute minimum — one box
- **1 × 8 vCPU / 8 GB / 200 GB NVMe** — everything (3 PM2 roles + Mongo RS + PG + Redis +
  MinIO), the `VPS_UBUNTU_SETUP.md` single-VPS build; Cloudflare Tunnel for edge.
- **~RM 183 ≈ ₹3,500/mo.**
- **Capacity:** 10k DAU at ≤~1,000 concurrent **with the derived-pools flag on**.
- **Bottleneck:** one failure domain; Argon2 + Mongo + PG share CPU; the global broadcast.
- **Upgrade trigger:** event-loop lag >50 ms sustained, or Cycle `findOneAndUpdate` p95
  climbing, or realtime egress → 100 Mbps.

### B) Recommended budget — two boxes (data isolated)
- **VPS1 8/8** — Node (3 roles) + Redis; **VPS2 8/8** — PostgreSQL + MongoDB (private
  network between them). Cloudflare Tunnel edge.
- **~RM 366 ≈ ₹7,000/mo.**
- **Capacity:** same 10k DAU, but money DBs no longer contend with Node for CPU, and an
  app restart doesn't touch the datastores. Headroom for growth to ~15–20k.
- **Bottleneck:** single app node (no app HA); Redis co-located with app.
- **Upgrade trigger:** app CPU sustained >60–70 %, or you need zero-downtime deploys.

### C) Safer — three boxes + real edge
- **VPS1 8/8** app; **VPS2 10/10** PostgreSQL (the money DB gets the headroom);
  **VPS3 4/4** Mongo + Redis + workers; **+ edge 4/4** (or Cloudflare Tunnel to drop it).
- **~RM 676 ≈ ₹12,850/mo** (or ~₹10,750 with Tunnel instead of the edge VPS).
- **Capacity:** 10k DAU with clear separation and room to ~25k before the realtime/room
  work is forced.
- **Bottleneck:** still a single app node; the global broadcast at high concurrency.
- **Upgrade trigger:** add app node #2 (needs PgBouncer then, §6) when app CPU or WS count
  climbs; room-scope emits before the realtime egress crosses ~100 Mbps.

All three are **under ₹15,000/mo.** Recommended: **B** (or **C** if you want the money DB
isolated from day one). **A** is genuinely fine to launch on and measure.

---

## 13. Shinjiru-specific

You need **none** of cPanel / CloudLinux / Imunify360 / LiteSpeed / Softaculous — this is
a Node + PM2 + Caddy stack on bare Ubuntu KVM (`VPS_UBUNTU_SETUP.md`). Buy the plain
**KVM VPS** (dedicated vCPU, NVMe, 100 Mbps + 1 Gbps DDoS per their page):
- **Launch (A):** 1 × **8 vCPU / 8 GB / 200 GB NVMe** (~RM 183).
- **Recommended (B):** 2 × **8 vCPU / 8 GB** (~RM 366).
- **Safer (C):** **8/8 + 10/10 + 4/4** (~RM 676), edge via Cloudflare Tunnel to stay
  cheapest.
Add 2 GB swap on any 8 GB box for Argon2 headroom (`VPS_UBUNTU_SETUP.md:59-65`).

---

## 14. Load-test plan (validate every estimate above)

Tools already in-repo: `loadtest/seed-accounts.mjs`, `loadtest/bet-contention.js`
(`package.json` `loadtest:seed`, `loadtest:bets`). Run against **staging that mirrors
prod** (same VPS sizes).

**Scenarios**
| # | Drives | Target |
|---|---|---|
| 1 | Concurrent WS | 100 → 500 → 1,000 → 1,500 → 2,500 sockets, each receiving the global broadcast |
| 2 | API RPS | ramp to 400 RPS mixed read/bet |
| 3 | Login storm | 500, 1,000, **3,000 logins/min** (§2 scenarios B/C/D) |
| 4 | Bet contention | `bet-contention.js` flag-OFF vs flag-ON — the derived-pools gate (`CAPACITY_PLANNING.md` §1.2) |
| 5 | Watchers/event | all sockets on both cycles (global today) |
| 6 | Odds cadence | bets at 10 / 20 / 40 per sec |
| 7 | Settlement | trigger cycle close under load; measure the payout pass |

**Pass/fail thresholds** (fail = scale or fix):
| Metric | Threshold |
|---|---|
| App CPU (per core) | < 70 % sustained |
| App RAM | < 80 %; no swap thrash |
| Event-loop lag | < 50 ms sustained |
| API p95 / p99 | p95 < 300 ms / p99 < 800 ms |
| Mongo `findOneAndUpdate` (Cycle) p95 | < 50 ms; write-lock % not climbing |
| PostgreSQL commit p95 | < 30 ms; connections < 70 % of `max_connections` |
| Redis command p95 | < 5 ms; no blocked clients; pub/sub backlog ~0 |
| WS delivery latency (emit→client) | < 500 ms at target concurrency |
| Packet loss | ~0 |
| Network | peak < 100 Mbps (included); else room-scope emits (§4) |

The single most important result: **scenario 4** tells you whether to flip the
derived-pools flag, and **scenario 1 at 2,500 sockets** tells you when the global
broadcast forces room-scoping.

---

## 15. Final report

1. **10k-DAU workload:** session-based betting on 2 concurrent cycles; **peak concurrent
   500–1,500** (5–15 % of DAU, **UNKNOWN exact — load-test**).
2. **Peak concurrent:** ~1,500 planning; measure it (scenario 1).
3. **Peak API RPS:** ~200–400 (band; **UNKNOWN exact**).
4. **Peak betting RPS:** ~10–40 writes/s (`CAPACITY_PLANNING.md` §1.2; **UNKNOWN exact**).
5. **Peak WS msgs/s:** `bet_rate × N_connected` — ~20–60k at the planning point (§4).
6. **Peak bandwidth:** ~32 Mbps @ 1,000 conn / 20 bps; scales to 100 Mbps+ only in the
   global-broadcast regime (§4 table).
7. **Mongo:** 2 vCPU / 2–4 GB, single-node RS; **hot Cycle doc is the contention** —
   flip the derived-pools flag (`bet.routes.js:281`, `cyclePool.service.js`). Exact size
   **UNKNOWN — load-test**.
8. **PostgreSQL:** 2 vCPU / 2–4 GB / NVMe; pool 10/proc (`pgClient.js:59`); **PgBouncer
   optional until the 3rd app node** (§6).
9. **Redis:** ~256–512 MB; may co-locate with Mongo at 10k; separate by ~25k (§7).
10. **Node:** 3 roles, no clustering; per-process RPS/WS ceiling **UNKNOWN — load-test**;
    login ~50/s/proc (repo estimate).
11. **Auth/Argon2:** argon2id 19 MiB / t=2 / p=1 (`password.util.js:23-26`); raise
    `UV_THREADPOOL_SIZE=8`; a 3,000/min storm saturates one process (§2).
12. **Cheapest safe architecture:** **A — one 8/8 VPS (~₹3,500/mo)** + Cloudflare Tunnel,
    derived-pools flag on.
13. **Recommended architecture:** **B — two 8/8 VPS (~₹7,000/mo)**, money DBs isolated.
14. **Shinjiru plan(s):** 1×8/8 (A) · 2×8/8 (B) · 8/8+10/10+4/4 (C); plain KVM, no
    cPanel/CloudLinux/LiteSpeed.
15. **Estimated INR/mo:** A ~₹3,500 · B ~₹7,000 · C ~₹10,750–12,850 — **all < ₹15,000**.
16. **Can be colocated (at 10k):** Node roles together; Mongo+Redis (+workers); edge via
    Cloudflare Tunnel (no VPS).
17. **Must be separated:** the **scheduler must stay a singleton** (leader-locked);
    exactly one active. For HA, a 2nd app node. Give Redis its own box by ~25k.
18. **First bottleneck expected:** the **global Socket.IO broadcast** (`bet.routes.js:422`
    — `N_connected × bet_rate`), then the **Cycle-document `$inc`** if the derived-pools
    flag is left off. Both are code fixes, not hardware.
19. **Exact scaling trigger:** event-loop lag > 50 ms sustained **or** realtime egress
    → 100 Mbps **or** Cycle `findOneAndUpdate` p95 climbing under load — whichever fires
    first (§14).
