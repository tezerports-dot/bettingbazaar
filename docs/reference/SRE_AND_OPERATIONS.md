# SRE and operations

> **This document holds data and history, never rules.** Every rule lives in
> `CLAUDE.md`, which is the single rules file and outranks this document.
> Extracted from the former `CLAUDE.md` on 2026-09-09.

Grounded in what the repo exposes: Prometheus metrics (`services/metrics.service.js`), the alert webhook (`alerting.service.js`), `/health/live`+`/health/ready` probes, and the Grafana dashboard (`deploy/grafana/`).

**SLOs (rolling 28d; error budget = 100%−SLO):**

| SLO | Target | Source |
|---|---|---|
| API availability (`/health/ready` 200) | 99.9% | uptime monitor (budget 40m19s/28d) |
| p99 latency, non-settlement GET | < 400 ms | `http_request_duration_seconds` |
| p99 latency, `POST /api/bet` | < 800 ms | same, route-labeled |
| Settlement success | ≥ 99.95% | `bb_settlement_runs_total{outcome}` |
| Ledger integrity | 100% (hard) | revenue `integrityOk` / `bb_ledger_reconcile_errors_total`==0 |
| Money-DB drift (PG live) | 0 rows (hard) | `bb_pg_drift_rows`==0, `bb_pg_trial_balance_ok`==1 |

**Hard SLOs** (ledger integrity, money-DB drift) have a **zero** error budget — any breach is a P1, never "spend the budget."

**Error-budget policy:** >25% ship normally · <25% freeze non-critical releases · exhausted → reliability/security only · hard-SLO breach → stop deploys, open P1, reconcile the ledger first.

**Golden signals:** Latency (`http_request_duration_seconds` buckets; alert p99 > SLO 10m) · Traffic (`_count` rate) · Errors (5xx rate from `status` label; alert >1% 5m) · Saturation (`bb_requests_shed_total`, `bb_pg_pool_connections{state="waiting"}`, event-loop lag). Money-path alerts wire to the webhook (10-min cooldown): ledger-reconcile, settlement-tick, and (PG live) `pg-drift`. Point `SystemConfig.alertWebhookUrl` at PagerDuty/Slack.

**Incident runbooks** (P1 = money incorrect or platform down · P2 = degraded · P3 = minor). First 5 min: check `/health/ready` per instance + Grafana; identify blast radius; if a deploy is implicated, **roll back first**, diagnose after.
- **Ledger integrity (P1):** do NOT hand-mutate balances. Pull the failing event via `GET /api/admin/revenue/ledger`; ledger is append-only (corrections are new offsetting entries); reconciler is idempotent; escalate to the money-domain owner.
- **Settlement failures (P1/P2):** idempotent + crash-resumable; a failed tick retries next cycle. If persistent, check PostgreSQL connectivity + the cycle lock. A cycle with no declared winner is never offered for settlement, so a stuck cycle is a declaration failure, not a settlement one — check that the winner was written **before** the status.
- **Money-DB drift:** not a failure mode. Drift is disagreement between two stores; there is one. The equivalent P1 is a **ledger that does not sum to the wallet row**, which is an application bug, not a sync lag — pull the failing transaction by `tx_id` and escalate to the money-domain owner. Do not hand-mutate a balance to make the sum work.
- **Overload (P2):** the edge sheds to protect the event loop — scale out (k8s replicas/Railway instances), raise the admin load-shed ceiling if headroom, check for a hot query. Rate-limit counters are Redis-shared, so scaling is safe.
- **Redis down (P2, self-mitigating):** rate-limit degrades to per-instance, cache to in-memory, realtime to single-instance (all by design). Restore Redis; no data loss (all durable state is in PostgreSQL).

**Capacity planning:** app tier is stateless → scale horizontally (k8s HPA on CPU: api **3→30** @ 65%, realtime **2→40** @ 60% — `deploy/k8s/deployment.yaml`). Inputs: RPS (`_count` rate), event-loop lag, pool waiting. **DB connections are the first ceiling:** keep `instances × PG_POOL_SIZE ≤` the PostgreSQL tier's connection budget (`max_connections`, minus what admin tooling and replication reserve). Review headroom monthly + before campaigns; load-test before raising the instance ceiling.

**Rollback:** Railway → redeploy previous deployment (or revert the merge on `main`). k8s → `kubectl rollout undo deployment/bettingbazaar` or flip the blue/green Service selector. Deploys are boot-safe: `validateEnv` fails fast on missing secrets, so a misconfigured rollout refuses to start.

**On-call quick reference:** dashboards `deploy/grafana/bettingbazaar-dashboard.json` · scrape `GET /metrics` (Bearer `METRICS_TOKEN` if set) · health `/health/live` (process) + `/health/ready` (deps+drain) · alert sink `SystemConfig.alertWebhookUrl` / `ALERT_WEBHOOK_URL` · DR `docs/governance/DISASTER_RECOVERY.md` · money rollback `database/DATA_ROLLBACK_PLAN.md`.

---
