# Disaster Recovery Plan (plan item 48) — 2026-07-13

Written AFTER the mechanisms it references exist (per the plan): automated
backups (item 45), alerting (38), health monitoring (30/32/33), leader-locked
jobs. Every step below refers to something real in this repo or a named owner
action — nothing aspirational.

**Targets:** RPO ≤ 24h from daily backups (≤ minutes once PITR is enabled, §3).
RTO ≤ 1h for app-tier failures, ≤ 4h for full database restore. Revisit after
the first staging drill.

## 1. App tier down (host outage, bad deploy)
Detection: uptime monitor / `tools/health-watch.mjs` pages the alert webhook
after 3 consecutive origin-health failures.
1. Check platform status + app logs (structured JSON, correlation ids).
2. Bad deploy → redeploy previous image (Railway: redeploy prior build; k8s:
   `kubectl rollout undo deploy/bettingbazaar` or flip the blue/green Service
   selector back — deploy/README.md).
3. Host outage → deploy the same image to the standby target (k8s manifests /
   compose stack are version-controlled and reproducible) and run the DNS step
   in §4.
Money safety: settlement/reconcile jobs are idempotent + crash-resume-proven
(CI); a mid-settlement crash resumes via payoutRecoveryTask on next boot.

## 2. Database restore (data corruption / loss)
Backups: daily `pg_dump` gzip archives in S3 `backups/` (newest 14 kept),
failure pages the webhook (services/backup.service.js).
1. STOP writes: enable maintenance mode (System Settings) — the guard blocks
   user traffic while admins keep access.
2. Download the chosen archive from S3.
3. `gunzip -c bb-<ts>.sql.gz | psql "$DATABASE_URL"` into a **freshly created,
   empty** database — never over a live one. Then repoint `DATABASE_URL`.
4. Run the ledger integrity check (GET /api/admin/revenue/summary →
   `integrityOk` must be true) before disabling maintenance mode. A restore that
   loads without error but fails this check is a restore you must not serve
   from: the balances and the ledger disagree.
**Drill (required, staging):** restore last night's archive into a scratch
database and boot the app against it. An untested backup is not a backup — do
this once now, then quarterly.

## 3. Point-in-time recovery (item 46)
- **OWNER ACTION, and the highest-priority one in this document.** Enable
  PostgreSQL **WAL archiving to off-box storage** (`archive_mode=on`,
  `archive_command` shipping to S3, or the managed host's equivalent). That gives
  point-in-time recovery to any second in the retention window, which is what
  actually matters for money: an incident is discovered minutes to hours after
  it starts, and a daily dump loses everything in between.
- **The daily dumps remain the provider-independent floor**, not the plan. With
  one database holding every domain, a dump-only posture means an incident at
  23:00 costs the whole day for money *and* identity *and* content at once.
- **Rehearse the PITR restore, not just the dump restore.** Restoring to a
  timestamp is a different procedure with different failure modes; the first time
  you run it should not be during an incident.

## 4. Domain / DNS failover (item 30 runbook)
Trigger: `tools/health-watch.mjs` (run OUTSIDE the primary host) pages after 3
consecutive origin-health failures — status/latency/TCP-TLS signals ONLY, never
client identity (hard constraint, see the tool header).
Preparation (owner, once): lower TTL to 300s on records that may fail over;
stand up the standby (deploy the image via deploy/ artifacts) and keep it
receiving the daily backup restore (or reading a replica).
Execution:
1. Confirm it's an origin failure (health endpoint down from ≥2 networks), not
   a monitor blip.
2. Repoint the A/CNAME to the standby at your DNS provider — or, if the
   provider has native health-checked failover (Route53 health checks,
   Cloudflare LB), pre-configure that instead using the SAME origin-health
   criteria and let it act automatically.
3. Verify: `curl -I https://<domain>/health` returns 200 from the standby;
   watch error rate on the Grafana dashboard.
**Failback DECISION (recorded, per the plan):** automatic failback is OFF.
Returning to the primary is a manual step after ≥30 min of verified health, in
a low-traffic window, because flapping between origins is worse than running
on the standby. health-watch announces recovery but does not act.

## 5. Secret compromise
Rotate per the deployment secret-rotation procedure (JWT_SECRET rotation logs everyone out —
use a maintenance window). Alert webhook + METRICS_TOKEN rotate from System
Settings / env without redeploy.

## 6. Who does what
- **Owner/admin:** DNS changes, Atlas PITR enablement, secret rotation,
  maintenance-mode toggle, restore approval.
- **Any operator:** §1 redeploys, §2 restore drill on staging, monitoring.
- Alerts arrive at the admin-configured webhook (System Settings →
  Operational Alerts); if that page is unreachable, `ALERT_WEBHOOK_URL` env is
  the fallback channel config.
