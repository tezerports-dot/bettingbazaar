# Production architecture — database authority, Hetzner sizing, and cost

Answers two questions that need deciding before production:

1. **Which database owns which data, permanently?**
2. **What hardware does ~50,000 DAU need, and what does it cost?**

Companion to `docs/GO_LIVE_RUNBOOK.md` (the ordered launch runbook —
Shinjiru dedicated box) and `docs/governance/LAUNCH_READINESS.md` (what gates a
launch). The Hetzner figures below are sizing/cost *reference*; the current plan
runs on a single Shinjiru dedicated box (`deploy/VPS_UBUNTU_SETUP.md`).

---

# Part 1 — MongoDB vs PostgreSQL

## Can Postgres take full authority today? No — and here is the evidence

This was asked directly: *give PostgreSQL full authority over all transactions,
keep MongoDB limited.* That is the right destination. **The code cannot do it
today**, and setting the environment variables would create a dangerous illusion
rather than the outcome.

`postgres/moneyAuthority.js` declares four paths — `WALLET`, `LEDGER`, `ORDERS`,
`KYC`. Only **one** is wired:

```
$ grep -rn "isPostgresAuthoritative(" backend --include=*.js | grep -v tests
backend/domains/wallet/walletAuthority.service.js:49   → MONEY_PATHS.WALLET
backend/startup/cronJobs.js:208                        → metrics reporting only
```

Nothing branches on `LEDGER`, `ORDERS` or `KYC`. Setting
`MONEY_AUTHORITY_LEDGER=postgres` would pass the boot coherence check and change
**no behaviour at all** — accounting events, payment orders and KYC would keep
reading and writing MongoDB, while the metrics gauge and the config both claimed
Postgres was authoritative. That is worse than not flipping: it removes the
signal that the work is outstanding.

What actually exists for Postgres today:

| Path | Postgres read/write | Status |
|---|---|---|
| Wallet balances | `walletPg.js` + `walletPgAuthority.js` | **Implemented** — flippable |
| Ledger / accounting events | none — `dualWrite.js` mirrors write-only | Mirror only |
| Payment orders, UTR registry | none — mirror only | Mirror only |
| User KYC | none — mirror only | Mirror only |
| **Merchant token wallet** | **none at all** | Mongo-only + mirror |

The merchant wallet is the one to notice. `merchantWallet.service.js` is the sole
writer of `Merchant.tokenBalance`, and it has **no Postgres counterpart** — not
even a declared path in `MONEY_PATHS`. Every user↔merchant settlement and
admin↔merchant token issuance is Mongo-only. So "Postgres authoritative for all
transactions" cannot include the merchant side however the env vars are set.

### What full authority would actually require

1. A Postgres read/write implementation for merchant tokens, mirroring
   `walletPg.js` (row lock, negative guard, ledger in the same transaction).
2. The same for accounting events, payment orders and KYC, each with an
   authority check at its call sites.
3. A `MONEY_PATHS.MERCHANT_WALLET` entry with its dependency ordering.
4. Reconciliation extended to cover each newly authoritative table.

That is substantial work — weeks, not a config change. Until it exists, the
honest posture is: **wallet is flippable, everything else is Mongo with a
verified mirror.**

### The wallet flip itself still has a gate

Even for the one implemented path, the recommendation in this document stands
and the audit strengthened it: the `LIKE`-pattern idempotency bug lived in
`walletPg.js` and was dormant *because* the flip had not happened, and the
adversarial pass then found that an unguarded checked-out client crashed the
process on a Postgres restart. Both are fixed. Both were in the path a flip
would activate. That is the argument for the reconciliation gate, not against
Postgres.

## The recommendation

**PostgreSQL becomes the permanent system of record for money. MongoDB keeps
everything else.** That is also the direction the code is already built for, so
this is a confirmation rather than a redesign — but the *sequencing* below
matters more than the destination, and one part of it should change.

### Split

| Data | Owner | Why |
|---|---|---|
| Wallet balances | **PostgreSQL** | Needs row locks and a constraint that refuses a negative balance. Postgres enforces this in one transaction; Mongo needs a filtered update plus a retry loop to approximate it. |
| Ledger / accounting entries | **PostgreSQL** | Append-only with a `UNIQUE` idempotency key and a conserve-to-zero check. These are real constraints in Postgres and application convention in Mongo. |
| Settlements, payouts, disputes | **PostgreSQL** | Multi-row, must be atomic with the ledger rows they produce. |
| Payment orders, UTR registry | **PostgreSQL** | Financial records; needs foreign keys to wallets/users. |
| Reconciliation | **PostgreSQL** | Already there. It is the thing that proves the other stores agree. |
| Reporting / analytics | **PostgreSQL** | Aggregates over financial data, and window functions are far better here. |
| User profiles, KYC metadata | **MongoDB** | Document-shaped, schema evolves, no cross-row invariants. |
| Bet history | **MongoDB** | High write volume, append-mostly, queried by user/cycle. The *money effect* of a bet is a ledger row in Postgres; the bet document itself is fine in Mongo. |
| Content / CMS, branding | **MongoDB** | Documents. |
| Game registry, odds, market config | **MongoDB** | Documents, frequently reshaped. |
| Chat, notifications, support tickets | **MongoDB** | Documents, TTL-expiring. |
| Sessions, rate limits, realtime | **Redis** | Ephemeral. |

The dividing line: **if two rows must agree or money is wrong, it belongs in
Postgres.** If a document can be wrong on its own without corrupting a balance,
Mongo is fine and better suited.

### Why not move everything to Postgres

It is a real option and some betting platforms do it. It is not recommended here
because the non-money collections are genuinely document-shaped and reshaped
often, and migrating them buys correctness you do not need while costing months
of schema work. The money paths are where the correctness argument is decisive,
and those are the ones already mirrored.

### Why not stay on Mongo

Mongo transactions work, and the current code uses them correctly. But the
guarantees are weaker in ways that matter for money:

- A negative-balance guard is a filter-plus-retry, not a constraint. Application
  bugs can produce states the database would have refused.
- Idempotency depends on a unique index that the application must remember to
  use, rather than a foreign key and a check constraint that make the wrong
  state unrepresentable.
- The Postgres money schema already has append-only and conserve-to-zero
  **triggers**. There is no Mongo equivalent.

## The sequencing — and the one change I recommend

The documented plan (`LAUNCH_READINESS.md` §E) flips **wallet first**, then
ledger, then orders, then KYC, gated on reconciliation being clean for 24h+.
The dependency ordering is right and the gate is right.

**The change: do not flip anything on Railway staging, and do not flip wallet
authority at launch. Launch on Mongo authority.**

Reasons:

1. **The cutover is a separate risk from the launch.** Launching and changing
   the source of truth for balances at the same time means an incident in the
   first week has two candidate causes. Do them weeks apart.
2. **The gate needs production traffic to be meaningful.** "Reconciliation clean
   for 24h" proves nothing on staging with synthetic load. It has to be real
   users, real deposits, real settlement cycles.
3. **Rollback is only cheap before the flip.** While Mongo is authoritative,
   Postgres is a mirror you can rebuild. After the flip, the reverse mirror
   keeps Mongo current — but you are now depending on that machinery being
   correct under load you have not yet seen.

So: **launch Mongo-authoritative, dual-writing to Postgres.** Watch
`bb_pg_drift_rows` at 0 and `bb_pg_trial_balance_ok` at 1 for a few weeks of
real traffic. Then flip wallet, then ledger, in separate deploys.

One caveat worth knowing: the wallet path is exactly where this audit found the
`LIKE`-pattern idempotency bug (now fixed, PR #104). That code was dormant
precisely because the flip has not happened. Treat the Postgres paths as
**less exercised than the Mongo ones**, and weight the reconciliation window
accordingly.

---

# Part 2 — Hetzner sizing for ~50,000 DAU

## Sizing honestly

**Do not buy this list yet.** These numbers come from the application's shape —
what it runs, how it fans out realtime, what its money path costs per bet — not
from measurements of *your* traffic. Nobody can size this accurately without
data, and Railway staging is how you get that data. Use this as a starting
point and a budget, then confirm against real numbers.

Working assumptions, stated so you can correct them:

- 50,000 DAU, peak concurrency ~5% = **~2,500 concurrent users**
- Realtime-heavy: most active users hold a WebSocket or SSE connection
- Peak ~500 req/s, bursting to ~1,500 during settlement
- Bets concentrated around cycle boundaries — the load is spiky, not flat

The spikiness is the important part. Betting load is not smooth: everyone bets
just before a cycle closes and everyone's balance updates when it settles. Size
for the spike.

## Recommended layout

| Role | Count | Hetzner type | vCPU / RAM | Disk | ~€/mo each |
|---|---|---|---|---|---|
| App (Node) | 3 | CCX23 (dedicated) | 4 / 16 GB | 160 GB | €49 |
| PostgreSQL primary | 1 | CCX33 (dedicated) | 8 / 32 GB | 240 GB + volume | €99 |
| PostgreSQL replica | 1 | CCX23 | 4 / 16 GB | 160 GB + volume | €49 |
| MongoDB replica set | 3 | CCX23 | 4 / 16 GB | 160 GB + volume | €49 |
| Redis primary + replica | 2 | CPX31 (shared) | 4 / 8 GB | 160 GB | €16 |
| Monitoring | 1 | CPX31 | 4 / 8 GB | 160 GB | €16 |

**Why dedicated (CCX) for app and databases:** shared vCPU (CPX) is subject to
steal time from neighbours. For a spiky, latency-sensitive money workload that
shows up as unexplained p99 latency during exactly the moments that matter.
Redis and monitoring are fine on shared.

**Why 3 Mongo nodes:** a replica set needs 3 members to elect a primary without
a split brain, and you need a replica set at all because the money code uses
transactions. This is not optional.

**Why a Postgres replica:** reporting queries and reconciliation should not
compete with money writes on the primary. It is also your fastest failover.

### Monthly cost

| Item | Qty | €/mo |
|---|---|---|
| CCX23 app nodes | 3 | 147 |
| CCX33 Postgres primary | 1 | 99 |
| CCX23 Postgres replica | 1 | 49 |
| CCX23 Mongo replica set | 3 | 147 |
| CPX31 Redis | 2 | 32 |
| CPX31 monitoring | 1 | 16 |
| Load balancer (LB11) | 1 | 6 |
| Block storage (~1 TB total) | — | 44 |
| Backup space (Storage Box BX21) | 1 | 12 |
| **Hetzner subtotal** | | **~€552** |
| Cloudflare Pro (WAF, DDoS) | 1 | ~€23 |
| Cloudflare R2 (~500 GB + egress) | — | ~€8 |
| **Total** | | **~€583/mo** (~US$630, ~₹53,000) |

Add ~20% headroom for snapshots, traffic overage, and a staging environment you
keep running: **budget €700/mo.**

**A cheaper start:** 2 app nodes, no Postgres replica, 3 Mongo nodes (still not
optional) ≈ **€380/mo**. That handles ~20,000 DAU comfortably and is the honest
place to begin if 50,000 is a target rather than current traffic. Scaling app
nodes later is a 10-minute operation; migrating a database is not — so size the
data tier for where you are going, and the app tier for where you are.

## Kubernetes: not recommended at this scale

You asked whether it is justified. For this workload: **no.**

Kubernetes earns its complexity when you have many services deployed by many
teams on independent schedules. You have **one** application plus databases,
deployed by one person. What k8s would give you here — rolling updates,
health-gated traffic, restart-on-failure — you can get from Docker Compose plus
the Hetzner load balancer, with a fraction of the operational surface.

What k8s would actually cost you: a control plane to keep patched, a CNI, an
ingress controller, cert-manager, CSI storage drivers, and the fact that
**running databases on k8s is its own specialty**. The failure modes are
unforgiving and debugging them at 3 a.m., as a non-programmer, is not a position
to be in.

The repo does contain k8s manifests in `deploy/`. They are useful later. The
recommendation is to defer them until you either have multiple services or hire
someone who operates k8s daily.

**Instead:** Docker Compose on each app node, Hetzner Cloud Load Balancer in
front with health checks against `/health`, and deploys that start the new
container, wait for it to report ready, then drain the old one. The graceful
shutdown for this is already implemented — `SIGTERM` fails readiness first, waits
for the load balancer to notice, then closes connections.

## Network and security layout

- **Private network (10.0.0.0/16).** Databases get *only* private IPs. Nothing
  but the app nodes can reach Postgres, Mongo, or Redis. This is the single
  biggest security improvement over the Railway setup, where Atlas has to accept
  `0.0.0.0/0`.
- **Firewall:** public ingress only to the load balancer on 443. App nodes accept
  traffic only from the load balancer. Databases accept only from app nodes.
- **SSH:** key-only, no passwords, ideally through one bastion.
- **Cloudflare in front:** DNS, WAF, DDoS protection, and CDN for static assets.
  Set `TRUST_PROXY` correctly or every rate limit will key off Cloudflare's IP
  instead of the user's — which silently disables per-IP rate limiting.
- **Cloudflare R2** for KYC documents, uploads, branding, and backups. No egress
  fees, which matters for a media-heavy KYC flow.

## Backups and disaster recovery

| What | How | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_basebackup` + WAL archiving to R2 | Continuous WAL, daily base | 30 days |
| MongoDB | `mongodump` from a secondary, to R2 | Every 6h | 30 days |
| Redis | RDB snapshot | Hourly | 7 days |
| Uploads/KYC | Already in R2 | — | Versioned |

**Point-in-time recovery for Postgres is the one that matters.** With WAL
archiving you can restore to any second. For a money platform that is the
difference between "we lost 6 hours of ledger" and "we lost nothing."

**Test the restore.** An untested backup is not a backup. Restore into a scratch
server quarterly and confirm the trial balance still reconciles.
`docs/governance/DISASTER_RECOVERY.md` has the runbook.

## Observability

The app already exposes Prometheus metrics at `/metrics` (token-protected) and
already ships the money-specific gauges you need: `bb_pg_drift_rows`,
`bb_pg_trial_balance_ok`, `bb_pg_reconcile_consecutive_clean`.

Stack: **Prometheus** (scrape), **Grafana** (dashboards), **Loki** (logs),
**Alertmanager** (paging). All on the monitoring node.

Alerts worth paging a human for, in priority order:

1. `bb_pg_trial_balance_ok` != 1 — money does not add up
2. `bb_pg_drift_rows` > 0 and rising — the two stores are diverging
3. `/health` failing on >1 app node
4. Postgres replication lag > 30s
5. Mongo primary election
6. p99 latency > 2s on bet placement

Distributed tracing (OpenTelemetry) is genuinely useful but is not where to
start. Metrics and logs will explain almost everything at this scale; add
tracing when you have a latency problem you cannot explain.

## Load testing before you commit to the sizing

`loadtest/` already contains a k6 bet-contention scenario and a seeding script.
Run these against Railway staging first, then against Hetzner before cutting
traffic over.

What to measure, and the expected first bottlenecks in order:

1. **Postgres write contention on `wallets`.** Every bet takes a row lock per
   user. Fine when users are distinct; the moment many bets hit one merchant or
   treasury account you serialise on that row. **Most likely first ceiling.**
2. **Mongo transaction throughput at cycle settlement.** Settlement touches many
   documents at once. Watch for write conflicts and retries.
3. **WebSocket/SSE fan-out memory on app nodes.** ~2,500 connections is
   comfortable; the cost is per-connection memory and Redis pub/sub throughput.
4. **Redis** as the shared bottleneck — it backs rate limits, realtime fan-out,
   and the job queue simultaneously. Consider splitting it into separate
   instances per concern if it saturates.

Rough expectation: the layout above should carry ~50k DAU with headroom, with
Postgres wallet contention the first thing to hit. Treat that as a hypothesis to
test, not a number to trust.

---

# Migration sequence: Railway → Hetzner

1. Stand up Hetzner infrastructure, private network, firewalls. No traffic.
2. Restore a staging database dump onto it. Run the test suites against it.
3. Run load tests. Fix what they find. Re-size if needed.
4. Set up monitoring and alerting. Confirm alerts actually fire.
5. Practise a restore from backup into a scratch server.
6. Put the site into maintenance mode; take a final dump from Railway.
7. Restore onto Hetzner. Verify: user count, wallet sum, ledger trial balance.
8. Repoint DNS at Cloudflare. Keep Railway running, untouched, for 48h.
9. Watch. If it goes wrong, DNS back to Railway.
10. After a week of clean reconciliation, decommission Railway.

Steps 7 and 8 are the ones people rush. The verification in step 7 — that the
sum of all wallet balances matches before and after — is the check that catches
a partial restore before your users do.
