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

## 0. The state that changes the math: one database carries everything

There is one datastore — **PostgreSQL** — and it holds every domain: wallets,
ledger, settlement, bets, cycles, identity, configuration, CMS and engagement.

This section previously described a dual-write period in which a second store
stayed authoritative for money, PostgreSQL shadowed it, and a reconciler swept
both — and told you to size for that overlap. **None of that exists** (`CLAUDE.md`).
The sizing consequence cuts both ways and is worth stating precisely:

- **Removed:** the second store's process and its replica-set requirement, the
  mirror write on every money mutation, and the reconciler's read load against
  both stores. That is real capacity back.
- **Added:** PostgreSQL now serves the reads and writes the other store used to,
  on top of the money path it already had.

The net is **almost certainly lower total load** — one write instead of two plus
a sweep — but it is a **different** load on **one** box, so **the PostgreSQL tier
sizing in this document is a hypothesis until re-measured** (`CAPACITY_AUDIT_10K.md`
§5, §14). Size the app tier from the numbers below with confidence; treat the
database line as provisional and load-test it before buying.


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
> for revocation — a **database read per authenticated request**. At scale, cache
> the revocation set in Redis (short TTL) so the bet path is not gated on a
> lookup. Confirm whether it is on every request before prioritising.

### 1.2 The cycle row was the contention point — the schema now makes it impossible  ✅

This was the single largest capacity item in earlier revisions, and it is now
**closed by construction rather than by a flag.** The contention was the real
user-bet path: every bet did a read-modify-write of pool counters on the one
cycle row it belonged to, so concurrent bets on the same cycle serialized on it
and adding app nodes did not help — they queued on the same row. That was the
`docs/governance/LATENCY.md` ceiling, and it arrived before database saturation.

**Why it cannot come back.** A bet holds `FOR SHARE` on its cycle row. A bet that
*also* updated that row would block against another bet doing the same, and the
pair deadlocks — PostgreSQL raises **40P01** and one of them dies. So real pool
totals are **not stored on the cycle row at all**; only phantom figures are. Real
pools are derived, which is the same rule the money ledger already follows —
*balances are derived from postings, never stored* (`04-GOVERNANCE.md` §1):

```
real_delhi = SUM(amount_paise) FROM bets WHERE cycle_id = $1 AND side = 'DELHI'
             AND is_phantom = false AND status <> 'REFUNDED'
```

Each bet is an independent insert contending with nothing; the pool is a
projection refreshed on a throttled tick for display. (The phantom path was never
the contention source — a handful of admin agents, and the equalizer overwrites
those figures, so they are stored rather than derived and never needed deriving.)

**Do not "optimise" this into a counter column on `cycles`.** It reads like an
obvious win and it is a deadlock.

**What is still owed here.** Nothing structural — the property is enforced by the
schema. One measurement remains: run `loadtest/bet-contention.js` to confirm that
parallel inserts sum loss-free at the target bet rate and that the derived
aggregate stays inside the refresh budget under concurrency. A unit test proves
the arithmetic; only real concurrency proves the absence of lost updates.

**Why not a counter, in one line:** deriving reuses work settlement already does
(it aggregates the bets anyway), and any stored counter on the cycle row
reintroduces the 40P01 deadlock above. There is no third option worth the risk.

---

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
event backbone, and fire-and-forget handlers already run settlement,
notifications and projections **off** the request path. The synchronous bet path
is one transaction: token verify → validate → cycle open-gate (`FOR SHARE`) →
debit/reserve under the wallet row lock → bet row → ledger rows, committed
together. Everything else (realtime notify, projections, stats) is fire-and-forget
or queued.

The guardrail is a discipline, not a change: **no new feature adds synchronous
work to the bet path.** A "log this to the database before responding" added to
bet placement is how the sync path silently regrows. Note the one thing that is
**not** optional to keep inside the transaction: the balance move, the bet row
and its ledger rows commit together, or a bet exists that no ledger explains.

### 1.8 The real pools never cross the public boundary  ✅ (structural)

Not a capacity item — a correctness/fairness one that the pool work made worth
locking down. The winner is the **minority real-bet side**, so `realDelhi` /
`realBombay` **disclose the result before it is declared**; `phantomDelhi` /
`phantomBombay` expose the house's balancing. The frontend is public code, so a
field in an HTTP body or socket payload is exposed whether or not the panel
renders it. Users may see **combined totals only** (`totalDelhi` / `totalBombay`
= real + phantom), which is what they watched during betting and reveals nothing.

This was already true, but by convention — three hand-written whitelists and
careful `emitPublic`-vs-`emitAdmin` discipline. It is now **structural**:
`domains/markets/cyclePublicView.js` is the one public projection every
user-facing HTTP route goes through, `assertPublicCycleSafe` wraps the live emits
(`cycle_snapshot`, public `cycle_result`, public `bet_placed`) so a forbidden
field throws instead of shipping, and `tests/unit/cyclePublicView.test.js` fails
CI if any public path names a real/phantom field. The boundary is
**representation-independent** — it projects whatever the cycle object carries —
so it holds identically however the pools are computed.

### 1.9 The scheduler is a non-scaling singleton  ✅

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
| Postgres (bet path) | **`wallets` row-lock wait time; 40P01 deadlock count** | lock waits climbing under concurrency, or any deadlock at all | a deadlock means something updates a row it also holds `FOR SHARE` (§1.2) — fix the query, not the box size |
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
| **Launch** | 1 × 8/8 | 1 × 8/8 | 1 × 4/4 Redis+workers | ~RM476 (≈ ₹9k) | §1.1 threadpool, §1.3 PgBouncer, §1.6 CF cache, §1.7 keep sync path lean — all before you need stage 2 |
| **10–25k** | 2 × 8/8 | 1 × 10/10 | Redis onto own box (§1.4) | ~RM859 | §1.5 deltas; re-measure the database tier here (§0) |
| **25–50k** | 2–3 × 8/8 | 10/10 primary + 10/10 replica | dedicated Redis | ~RM1,041 | the replica is read-scaling **and** the failover target, so match it to the primary |
| **50–100k+** | +app nodes | larger primary + replica(s) | separate RT-Redis / control-Redis / workers | load-test-driven | write path scales via PgBouncer + schema, never via a replica |

One correction to a naive reading: the PostgreSQL **replica** offloads reads
(reporting, analytics), not the write path — the write path scales via PgBouncer +
schema, not a replica. The bet path's old ceiling (a single serialization point
that no number of app nodes got past) is gone; §1.2 explains why, and why
reintroducing it as a counter column would be a deadlock rather than a slowdown.

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
