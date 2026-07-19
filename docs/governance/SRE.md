# SRE & Operations — Betting Bazaar

Site-reliability guidance grounded in what this repo actually exposes: the
Prometheus metrics in `backend/services/metrics.service.js`, the alert webhook in
`alerting.service.js`, the `/health/live` + `/health/ready` probes (AQ-4), and
the Grafana dashboard in `deploy/grafana/`. Capability 2026-addition: SRE
(runbooks, incident playbooks, capacity planning, SLOs/error budgets).

## 1. Service Level Objectives (SLOs)

Measured over a rolling 28-day window. Error budget = 100% − SLO.

| SLO | Target | Metric source | Error budget (28d) |
|---|---|---|---|
| API availability (`/health/ready` 200) | 99.9% | uptime monitor / `bb` up | 40m 19s |
| API latency — p99 non-settlement `GET` | < 400 ms | `http_request_duration_seconds` (histogram) | — |
| API latency — p99 `POST /api/bet` | < 800 ms | same, route=`/api/bet` | — |
| Settlement success rate | ≥ 99.95% | `bb_settlement_runs_total{outcome}` | — |
| Ledger integrity | 100% | revenue summary `integrityOk` / `bb_ledger_reconcile_errors_total`==0 | 0 (hard) |
| Money-DB drift (once PG live) | 0 rows | `bb_pg_drift_rows`==0, `bb_pg_trial_balance_ok`==1 | 0 (hard) |

**Hard SLOs** (ledger integrity, money-DB drift) have a zero error budget —
any breach is a P1 incident, never "spend the budget." They gate correctness of
money, not user experience.

## 2. Error-budget policy

- Budget > 25% remaining: ship normally.
- Budget < 25%: freeze non-critical releases; prioritize reliability fixes.
- Budget exhausted: only reliability/security fixes until the window recovers.
- Hard-SLO breach: stop deploys, open a P1, reconcile the ledger before resuming.

## 3. Golden signals → where to look

| Signal | Metric | Alert threshold |
|---|---|---|
| Latency | `http_request_duration_seconds` buckets | p99 > SLO for 10m |
| Traffic | `http_request_duration_seconds_count` rate | — (capacity input) |
| Errors | 5xx rate from the histogram `status` label | > 1% for 5m |
| Saturation | `bb_requests_shed_total` (load-shed 503s), `bb_pg_pool_connections{state="waiting"}`, event-loop lag (default metrics) | shed rate rising; waiting > 0 sustained |

Money-path alerts already wire to the webhook (`alerting.service.js`, 10-min
cooldown): ledger-reconcile failures, settlement-tick failures, and (once PG is
live) `pg-drift`. Point `SystemConfig.alertWebhookUrl` at PagerDuty/Slack.

## 4. Incident response playbook

**Severities:** P1 = money incorrect or platform down · P2 = degraded/partial ·
P3 = minor, no user impact.

**First 5 minutes (any Sev):**
1. Check `/health/ready` on each instance and the Grafana dashboard.
2. Identify blast radius: one instance vs fleet, one route vs all.
3. If a deploy is implicated → roll back first (see §6), diagnose after.

**Runbook — Ledger integrity alert (`integrityOk:false` / reconcile errors):** P1.
Do NOT mutate balances by hand. Pull the failing `AccountingEvent`/source via
`GET /api/admin/revenue/ledger`; the ledger is append-only, so corrections are
new offsetting events, never edits. The reconciler is idempotent — re-running is
safe. Escalate to the money-domain owner.

**Runbook — Settlement failures (`bb_settlement_runs_total{outcome="error"}`):** P1/P2.
Settlement is idempotent (unique tx ids) and crash-resumable; a failed tick
retries next cycle. If persistent, check Mongo connectivity and the cycle lock;
`settlementConcurrency.integration.test.js` documents the invariants.

**Runbook — Money-DB drift (`bb_pg_drift_rows > 0`, PG live):** P1. Run
`npm run reconcile:pg -- --hours 168` for detail. Do NOT flip authority while
drifting. `DATA_ROLLBACK_PLAN.md` has the per-phase fallback.

**Runbook — Overload (`bb_requests_shed_total` climbing / pool waiting):** P2.
The edge is shedding to protect the event loop. Scale out (raise k8s replicas /
Railway instances), raise the admin load-shed ceiling if headroom exists, and
check for a hot query. Rate-limit counters are Redis-shared, so scaling is safe.

**Runbook — Redis down:** P2, self-mitigating. Rate limiting degrades to
per-instance, cache to in-memory, realtime fan-out to single-instance (all by
design). Restore Redis; no data loss (money is in Mongo/PG).

## 5. Capacity planning

- **Scaling unit:** the app tier is stateless (JWT auth, Redis-shared limits,
  cron leader election, SSE/socket Redis bridge, S3 assets) — scale horizontally.
  HPA targets 70% CPU (`deploy/k8s`), min 2 / max 6.
- **Inputs:** `http_request_duration_seconds_count` rate (RPS), event-loop lag,
  and `bb_pg_pool_connections{state="waiting"}` / Mongo pool saturation.
- **Database connections:** each instance opens up to `MONGO_MAX_POOL_SIZE` (10)
  + `PG_POOL_SIZE` (10). Keep `instances × pool ≤` the DB tier's connection
  budget (Atlas/managed-PG cap). This is the first ceiling hit when scaling out.
- **Cadence:** review headroom monthly and before any campaign/traffic event;
  load-test before raising the instance ceiling.

## 6. Rollback

- **Railway:** redeploy the previous deployment from the dashboard (or revert the
  merge on `main` and let it redeploy).
- **Kubernetes:** `kubectl rollout undo deployment/bettingbazaar`, or flip the
  blue/green Service selector (`deploy/k8s/README.md`).
- Deploys are boot-safe: `validateEnv` fails fast on missing required secrets,
  so a misconfigured rollout refuses to start rather than serving broken.

## 7. On-call quick reference

- Dashboards: import `deploy/grafana/bettingbazaar-dashboard.json`.
- Scrape: `GET /metrics` (Bearer `METRICS_TOKEN` if set).
- Health: `GET /health/live` (process), `GET /health/ready` (deps + drain).
- Alert sink: `SystemConfig.alertWebhookUrl` (admin-editable) / `ALERT_WEBHOOK_URL`.
- DR: `docs/governance/DISASTER_RECOVERY.md`. Money rollback: `backend/postgres/DATA_ROLLBACK_PLAN.md`.
