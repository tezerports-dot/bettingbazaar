# Capacity planning — the optimizations that come before hardware

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Sizing for this platform, grounded in where **this** code actually bends — not a
generic DAU→servers table. The governing principle: **remove a bottleneck from
the critical path before you enlarge it.** A bigger box for a serialized hot
document buys you almost nothing; removing the serialization buys you an order of
magnitude for the price of a schema change.

One hard line runs through everything below and is never crossed: **the financial
authority path stays strongly consistent and ACID.** Every optimization here
removes *contention around* the money path — never the money path's correctness.
Deltas, async fan-out, counter sharding and caching are for everything that is
not the debit, the reserve, and the double-entry ledger.

> **Not a licence, and not a capacity guarantee.** Real numbers come from a load
> test (`docs/governance/LAUNCH_READINESS.md` §D); the tiers below are a buy
> *order*, not a promise. And none of it substitutes for the licence/AML/pen-test
> gate in §G.

**Where this sits:** `VPS_UBUNTU_SETUP.md` builds the origin, `vps/EDGE_ORIGIN_HARDENING.md`
puts it behind the edge/tunnel, `docs/governance/LATENCY.md` has the measured
ceilings. This doc is the sizing and the **app/schema changes that change the
sizing**.

---

## 0. The state that changes the math: money is still on Mongo

The clean "PostgreSQL = money, MongoDB = app data" split is the **post-flip**
steady state. Today the money-authority cutover is **off** by design
(`MONEY_AUTHORITY_*` unset), so every money write:

1. commits to **Mongo** (still authoritative), then
2. mirrors to **Postgres** (the shadow, fire-and-forget), then
3. is swept by **reconciliation**.

So at launch **Mongo carries the wallet/ledger/settlement write load too**, plus
a mandatory single-node replica set for its transactions, *and* Postgres takes
the same writes as a shadow, *and* reconcile adds read load to both. Do not
under-provision Mongo at go-live believing it only holds profiles. The workload
separates the day authority flips (an owner-gated sequence,
`LAUNCH_READINESS.md` §E) — size for the dual-write period until then.

---

## 1. The bottlenecks, grounded — with the move, the cost, and the status

Legend: ✅ already in the code · 🟢 free config · 🟡 app change (needs design) ·
🔴 project (spike + invariant proof first)

### 1.1 Login is Argon2-bound — and it is *only* login  ✅🟢

`authenticate` verifies a **PASETO token signature** on every request
(`domains/identity/auth.middleware.js` → `verifyJwt`) — **no Argon2 on the hot
path.** Argon2id runs only at **login / registration / password change**. That is
the good news and it is already true: a logged-in user placing bets never touches
a password hash.

What remains: each Argon2 verify is ~80 ms and ~19 MiB pinned on the libuv
threadpool, so one process tops out near **50 logins/sec** at the default
`UV_THREADPOOL_SIZE=4`. The sizing event is therefore a **login storm** (a match
opens, 3,000 people sign in in a minute), not steady-state RPS.

- **Move (free/now):** raise `UV_THREADPOOL_SIZE` (budget ~19 MiB RAM/thread);
  keep the **api** role on its own process/node so a login surge cannot starve
  odds delivery. The auth endpoints are already shaped by `authLimiter` /
  `adminAuthLimiter` and Turnstile — the storm is bounded, not unbounded.
- **Move (later, 🔴):** a dedicated auth worker pool, or **passkeys/WebAuthn** to
  remove password hashing from most logins. Both are real wins but security-
  sensitive projects (WebAuthn needs a recovery path and interacts with KYC) —
  not day-one, and not a substitute for the free change above.
- **Do NOT** weaken Argon2 parameters to make login cheaper. It is memory-hard on
  purpose (OWASP). Cheaper login by weaker hashing is a security regression, not
  an optimization.

> Aside worth verifying: `authenticate` also does `TokenBlacklist.findOne({token})`
> for revocation — a **Mongo read per authenticated request**. At scale, cache the
> revocation set in Redis (short TTL) so the bet path is not gated on a Mongo
> lookup. Confirm whether it is on every request before prioritising.

### 1.2 The Cycle document is the real contention point — and the fix is already built, dormant  🟡

This matters more than any Mongo box you could buy, and a spike into it
(2026-08-12) found the redesign **already implemented behind a flag**, not
missing. The contention is the **real user-bet** path — one document,
read-modify-write, per bet:

```
bet.routes.js:281   Cycle.findOneAndUpdate({cycleId, status:OPEN|MERGED}, {$inc:{realDelhi, totalDelhi}})
```

Concurrent bets on the same cycle **serialize on that document** — WiredTiger is
document-level, so same-document `$inc`es queue; adding app nodes does not help,
they queue on the same doc. That is the `docs/governance/LATENCY.md` ceiling, and
it arrives before Postgres saturation. (The phantom path at `bet.routes.js:538`
looks identical but is **not** the contention source — a handful of admin agents,
and the equalizer overwrites those pools with `$max`, so they can't be derived
and never needed to be.)

**What exists:** `domains/markets/cyclePool.service.js`, gated on
`FLAGS.DERIVED_CYCLE_POOLS` (default **off**, a proven no-op when off). It takes
the "append + derive" path — the one that matches the money ledger's own rule,
*balances are derived from postings, never stored* (`04-GOVERNANCE.md` §1):

```
realDelhi  = SUM(Bet.amount) WHERE cycleId, side=DELHI,  isPhantom=false, status≠REFUNDED
```

Each bet is an independent insert that contends with nothing; the pool becomes a
projection recomputed from the bets, refreshed on a throttled tick for display
and **exactly** (majority read) at the two moments it turns into money.

**Where the invariant has to hold — and does.** The single rule: *any read of the
real pool that decides an outcome or becomes money must be freshly derived under
majority read, and must fail closed if it can't be.*

| Moment | Requirement | Status in code |
|---|---|---|
| **Winner = minority real side** | exact pool; **refuse to settle** if refresh fails | ✅ `cycleGenerator.js:314-322` aborts and retries next tick — never settles on stale fields |
| **Payout amounts** | must not come from the pool at all | ✅ settlement pays per **Bet row** (`gameEngine.processPayouts`); pool staleness cannot mispay |
| **netProfit (house accounting)** | exact; may fall back | ✅ `gameEngine.js:513-519` exact, falls back to stored on failure — payouts already moved and the **ledger** is authoritative, so this is a reporting-only staleness |
| **TOCTOU open-gate** | closed under both modes | ✅ stored: the `$inc` is the gate; derived: gate is a read, window re-closed by re-reading status post-insert + a conditional-delete that races settlement for the row (`bet.routes.js:258-348`) |
| **Phantom equalizer** | must not corrupt real pools | ✅ reads `realDelhi` for the display total only, never writes it; `$max` decision is phantom-only (`cycleGenerator.js:475-493`) |
| **Refund accounting** | refunded stake leaves the pool | ✅ `computeRealPools` excludes `REFUNDED`, counts `WON/LOST/PENDING` (money was staked) |

So the invariant is not an open question — it is already located at exactly these
seams and enforced. The derived path is correct **by inspection.**

**The gate before flipping the flag** (this is the actual remaining work, and it
is small):

1. **Run `loadtest/bet-contention.js`** flag-off vs flag-on. The module's own
   header forbids enabling it in production first — it is a money path, and the
   load test is what proves both that the ceiling is real *and* that parallel
   inserts sum loss-free. The unit test (`tests/unit/cyclePool.test.js`) proves
   the logic (the off-state no-op, read-concern selection, the memo) but mocks
   Mongo, so the no-lost-updates and majority-visibility properties are only
   proven under real concurrency.
2. **Add one integration test** (real Mongo): derived and stored pick the **same
   winner and netProfit** for identical bets, and winner determination **refuses
   to settle** when the exact refresh fails.
3. **Fix a load side-effect the spike found:** `refreshRealPools` writes with
   `Cycle.findOneAndUpdate`, which trips `cycle.model.js:94`
   `post('findOneAndUpdate') → mirrorCycleSettlement` on **every ~1s refresh per
   active cycle**. It is idempotent, so it is not a correctness bug — but it is
   needless Postgres write churn in a change whose whole purpose is to cut write
   load. Gate that hook to fire only on a settlement-state transition (or refresh
   via a path that does not trip the settlement mirror) before flipping the flag.

**Why not the other two options.** A **sharded Mongo counter** (N sub-docs summed
on read) also removes the single-doc queue, but settlement already aggregates the
bets, so deriving reuses work the system does anyway — the shard counter is
strictly more moving parts for no gain here. A **Postgres counter row** is the
*better end state* — once money authority is on PG (§0), the bet's debit, its
ledger entry, and its pool update become **one ACID transaction in one store** —
but only after the flip; before it, a PG pool splits the pool from
Mongo-authoritative money and adds a cross-store write. Sequence: **ship the
derived-from-bets flag now** (after the gate above), **migrate the pool into the
money transaction on Postgres after the authority cutover.**

### 1.3 Postgres connections — PgBouncer, and it's safe here  🟢

The pool is **`PG_POOL_SIZE || 10` per process** (`postgres/pgClient.js`). With
`api + realtime + scheduler` = 3 processes/node, two app nodes already reach ~60
connections against Postgres's default `max_connections=100`; a third node tips
it over. The fix is not a bigger PG box — it is **PgBouncer in transaction mode**
in front of the primary, so app nodes multiply without multiplying PG backends.

Verified safe for this codebase: **no session-scoped advisory locks** (only
`FOR UPDATE` row locks *inside* transactions), so transaction pooling holds.
Standard caveats still apply — avoid named server-side prepared statements and
session-level `SET` under transaction pooling; the app uses plain parameterized
queries today, so keep it that way.

### 1.4 Redis is realtime-critical, not just cache — split its roles  🟡

One `REDIS_URL` currently backs four jobs of very different criticality:
**Socket.IO cross-node fan-out** (`@socket.io/redis-adapter` — this *is* the
horizontal-realtime mechanism), the **scheduler leader lock**, **rate-limit
counters**, and **ipDefense**. A rate-limit spike or a worker stall then degrades
odds fan-out *and* leader election at once.

- **Move (🟡, ~25k):** split **logically first** — a realtime keyspace (pub/sub +
  live state) and a control keyspace (locks, counters) — then **physically** onto
  its own small instance. Give Redis its own box by 25k DAU, earlier than a naive
  plan would, precisely because it is on the odds hot path once you run >1
  realtime node.

### 1.5 Odds fan-out: serialize-once is already done; deltas are the next win  ✅🟡

The emitters use `io.to(\`event-…\`).emit(...)` (room emits). Socket.IO **encodes
the packet once per emit** and reuses the frame across every socket in the room —
so "don't serialize 3,000 times" is already handled *as long as broadcasts stay
room emits and never loop per-socket* (the per-user loop in `realtimeEmitters.js`
is only for unique payouts, which is correct). Keep it that way; a future "emit
per socket" is the regression to watch for.

The remaining win is **delta updates** (🟡): send `{version, changed fields}`
instead of the whole odds object each second. At thousands of watchers this cuts
bandwidth and serialization. It needs a **resync path** — clients that miss a
delta must recover via a version number and a periodic full snapshot — so it is
an app change with a correctness edge, not a free toggle.

### 1.6 Cloudflare should serve the static app, not the origin  🟢

The **api** role serves the three SPA bundles as static files. If 10,000 users
each pull the same bundle from the origin, that is origin bandwidth spent on
immutable JS. Put the bundles behind Cloudflare's cache (immutable `Cache-Control`
+ a cache rule); cache **only** static assets and genuinely public metadata —
**never** balance, wallet, bets, settlements, or any authenticated financial
state. Near-free, and it is the cheapest large bandwidth saving available.

### 1.7 The synchronous path is already minimal — keep it that way  ✅

Async is largely the existing architecture: BullMQ, the **worker** role, the
event backbone, and fire-and-forget mirrors already run settlement, notifications,
reconciliation and the PG mirror **off** the request path. The synchronous bet
path is just: token verify → validate → `Cycle` open-gate → debit/reserve
(wallet authority) → ledger. Everything else (realtime notify, projections,
stats, emails, dual-write, reverse mirror) is already fire-and-forget or queued.

The guardrail is a discipline, not a change: **no new feature adds synchronous
work to the bet path.** A "log this to Mongo before responding" added to bet
placement is how the sync path silently regrows.

### 1.8 The scheduler is a non-scaling singleton  ✅

Exactly one **scheduler** process is active (game-cycle producer + cron),
Redis-leader-locked; its load is independent of DAU. The pattern is **1 active +
1 hot standby** waiting on the lock — never N schedulers. Deploy the role on ≥2
nodes so the lock can fail over; do not "scale" it.

---

## 2. Metrics that trigger a change — watch these, not DAU

Scale on a firing metric, not on a user-count milestone. Each row says what to do
**instead of** buying a bigger everything.

| Subsystem | Watch | Trigger | Action (cheapest first) |
|---|---|---|---|
| App / api | event-loop lag; threadpool saturation; login p95 | lag >50 ms sustained, or login p95 climbing | raise `UV_THREADPOOL_SIZE`; add an api node behind the edge |
| Realtime | WS/node; Redis pub/sub throughput; fan-out latency | fan-out latency rising with a second RT node | split Redis (§1.4); then add RT node |
| Mongo | **Cycle doc write-lock % / `findOneAndUpdate` latency on the bet path** | bet-path write latency rising under concurrency | **flip the already-built derived-pools flag (§1.2) after its gate — not a bigger box** |
| Postgres | connections vs `max_connections`; commit latency; IOPS | connections >70% of max | **PgBouncer (§1.3)**; then a read replica for reporting |
| Redis | CPU; blocked clients; pub/sub backlog | control load interfering with RT | logical split → own instance (§1.4) |
| Queue | backlog depth; worker lag | backlog growing between ticks | add worker processes (they scale horizontally freely) |
| Edge | origin bandwidth; cache HIT ratio | low HIT ratio on static | Cloudflare cache rules (§1.6) |

---

## 3. The buy order — free/app changes first, hardware only on a trigger

VPS tiers are Shinjiru KVM regular monthly (not the 36-month promo). The point of
the ordering is that **most of section 1 is done before any of this is bought.**

| Stage | App | Postgres | Other | ~VPS/mo | Do the app-side work first |
|---|---|---|---|---|---|
| **Launch** | 1 × 8/8 | 1 × 8/8 | 1 × 4/4 Mongo+Redis+workers | ~RM476 (≈ ₹9k) | §1.1 threadpool, §1.3 PgBouncer, §1.6 CF cache, §1.7 keep sync path lean — all before you need stage 2 |
| **10–25k** | 2 × 8/8 | 1 × 10/10 | Redis onto own box (§1.4); Mongo 4/4 | ~RM859 | §1.2 derived-pools flag flip (after the load test) should land here; §1.5 deltas |
| **25–50k** | 2–3 × 8/8 | 10/10 primary + 8/8 replica | dedicated Redis; Mongo 4–8/… | ~RM1,041 | replica is for reporting/read-scaling, not write throughput |
| **50–100k+** | +app nodes | larger primary + replica(s) | separate RT-Redis / control-Redis / Mongo / workers | load-test-driven | only after §1.2 is done — otherwise the Cycle doc caps you regardless |

Two corrections to a naive reading: the Postgres **replica** offloads reads
(reporting, analytics), not the write path — the write path scales via PgBouncer +
schema, not a replica. And **adding app nodes past ~2 does nothing** for the bet
path until §1.2 lands, because the Cycle document is the serialization point no
number of app nodes gets past.

Currency: RM476 ≈ ₹9k (1 MYR ≈ ₹19). A "₹15–20k/mo" figure is stage-1 VPS **plus**
off-box backups, WAF/LB, monitoring and payment costs — don't double-count the
base. Off-box backups for the PG ledger are mandatory, not optional
(`VPS_UBUNTU_SETUP.md` §13, `DISASTER_RECOVERY.md`).

---

## 4. The line that does not move

Everything above removes contention *around* the money path. The money path
itself stays synchronous, ACID and strongly consistent:

- **Debit / reserve / withdrawal hold** — synchronous, transactional, refuses on
  insufficient funds. Never queued, never eventual.
- **Double-entry ledger** — conserve-to-zero, append-only, DB-enforced. Idempotent
  by caller-supplied `txId`.
- **Authority flips** — per-path, dependency-ordered, owner-gated, reconciled with
  rollback (`LAUNCH_READINESS.md` §E). Not a performance lever.

Counter sharding (§1.2) applies to the *pool tallies*, not the wallet. Delta
updates (§1.5) apply to *odds display*, not to what a bet debited. If an
optimization would make a balance or a ledger entry eventually-consistent, it is
out of scope by construction — the goal is to remove contention, never to trade
correctness for speed.
