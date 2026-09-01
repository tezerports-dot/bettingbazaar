# Production architecture — sizing and cost

Answers the sizing question that needs deciding before production:

1. **What hardware does ~50,000 DAU need, and what does it cost?**

Companion to `docs/GO_LIVE_RUNBOOK.md` (the ordered launch runbook —
Shinjiru dedicated box) and `docs/governance/LAUNCH_READINESS.md` (what gates a
launch). The Hetzner figures below are sizing/cost *reference*; the current plan
runs on a single Shinjiru dedicated box (`deploy/VPS_UBUNTU_SETUP.md`).

---

# The database

**PostgreSQL, for everything.** There is one store; nothing here needs deciding.

This document previously opened with a Part 1 that weighed two database engines,
which weighed a permanent split of the data between two engines, listed which
paths were implemented on each side, and sequenced a per-path cutover. **That
question is closed and its machinery is deleted** — see `CLAUDE.md` and the
2026-09-01 entry in `docs/governance/04-GOVERNANCE.md`. The platform is
pre-deployment, so there was nothing to migrate and nothing to split.

What the deleted section got right is worth keeping in one paragraph, because it
still constrains the sizing below: the money paths need strong ACID semantics,
row-level locking and integer money at rest, and those are properties of the
database rather than of the application on top of it. Everything else — cycles,
realtime, sessions, content, engagement — is stored in the same PostgreSQL, with
read-mostly configuration and CMS documents in JSONB columns. That is a schema
choice, not a second store.

For sizing purposes the consequence is simple: **one database tier to provision,
one connection budget to stay inside, one backup and PITR story to rehearse.**
The figures below assume that.

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
| PostgreSQL replica | 1 | CCX33 | 8 / 32 GB | 240 GB + volume | €99 |
| Redis primary + replica | 2 | CPX31 (shared) | 4 / 8 GB | 160 GB | €16 |
| Monitoring | 1 | CPX31 | 4 / 8 GB | 160 GB | €16 |

**Why dedicated (CCX) for app and databases:** shared vCPU (CPX) is subject to
steal time from neighbours. For a spiky, latency-sensitive money workload that
shows up as unexplained p99 latency during exactly the moments that matter.
Redis and monitoring are fine on shared.

**Why the replica matches the primary:** PostgreSQL carries every domain here,
not only the money paths, so the replica is doing real work — reporting, admin
analytics and the read-mostly configuration and CMS queries — and it is also the
failover target. A replica half the size of its primary is a failover that turns
an incident into an outage the moment it is promoted.

**Sizing caveat, stated plainly:** these figures were first derived when the
workload was split across two database tiers. Consolidating onto one does not
make the work disappear — it moves it. The app-tier and Redis numbers are
unaffected, but **the PostgreSQL tier's sizing is now a hypothesis that needs
re-measuring** against the load test in the section below before anyone commits
to hardware. Expect the primary, not the app nodes, to be what needs upsizing.

### Monthly cost

| Item | Qty | €/mo |
|---|---|---|
| CCX23 app nodes | 3 | 147 |
| CCX33 Postgres primary | 1 | 99 |
| CCX33 Postgres replica | 1 | 99 |
| CPX31 Redis | 2 | 32 |
| CPX31 monitoring | 1 | 16 |
| Load balancer (LB11) | 1 | 6 |
| Block storage (~700 GB total) | — | 30 |
| Backup space (Storage Box BX21) | 1 | 12 |
| **Hetzner subtotal** | | **~€441** |
| Cloudflare Pro (WAF, DDoS) | 1 | ~€23 |
| Cloudflare R2 (~500 GB + egress) | — | ~€8 |
| **Total** | | **~€472/mo** (~US$510, ~₹43,000) |

Add ~20% headroom for snapshots, traffic overage, and a staging environment you
keep running: **budget €570/mo.**

**A cheaper start:** 2 app nodes, one PostgreSQL primary with no replica, Redis,
monitoring ≈ **€300/mo**. That handles ~20,000 DAU comfortably and is the honest
place to begin if 50,000 is a target rather than current traffic. Note what you
are giving up: with no replica, failover is a restore from backup, so rehearse
that restore before you rely on it. Scaling app
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
  but the app nodes can reach PostgreSQL or Redis. This is the single biggest
  security improvement over a managed-database setup that has to accept
  `0.0.0.0/0`.
- **Firewall:** public ingress only to the load balancer on 443. App nodes accept
  traffic only from the load balancer. Databases accept only from app nodes.
- **SSH:** key-only, no passwords, ideally through one bastion.
- **Cloudflare in front:** DNS, WAF, DDoS protection, and CDN for static assets.
  Set `TRUST_PROXY` correctly or every rate limit will key off Cloudflare's IP
  instead of the user's — which silently disables per-IP rate limiting.
- **Cloudflare R2** for payment proofs, chat attachments, branding assets and
  backups. No egress fees. It holds **no identity documents** — KYC is an
  Aadhaar number, so there is no media-heavy KYC flow to size for.

## Backups and disaster recovery

| What | How | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_basebackup` + WAL archiving to R2 | Continuous WAL, daily base | 30 days |
| Redis | RDB snapshot | Hourly | 7 days |
| Uploads (proofs, chat, branding) | Already in R2 | — | Versioned |

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
2. `/health` failing on >1 app node
3. Postgres replication lag > 30s
4. A cycle past its declaration time with no winner written — settlement cannot
   proceed and will not retry its way out of it
5. p99 latency > 2s on bet placement

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
2. **Settlement throughput at cycle close.** Settlement touches many rows at
   once, under the same row locks bet placement uses. Watch for lock waits and
   deadlock retries (40P01) — and note that real pool totals are derived from
   `bets` rather than stored on the `cycles` row precisely because storing them
   there deadlocks.
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
