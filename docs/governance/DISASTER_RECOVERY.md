# Disaster Recovery Plan (plan item 48) — 2026-07-13

Written AFTER the mechanisms it references exist (per the plan): automated
backups (item 45), alerting (38), health monitoring (30/32/33), leader-locked
jobs. Every step below refers to something real in this repo or a named owner
action — nothing aspirational.

**Targets:** RPO ≤ ~1 minute with the WAL archive (§3), ≤ 24h from the nightly dump alone.
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
Backups: daily `pg_dump` custom-format archives in the PRIVATE bucket
`BACKUP_S3_BUCKET`, under `backups/` (newest 14 kept), never in the public
upload bucket; a failure or a missing bucket pages the webhook
(services/backup.service.js).
1. STOP writes: enable maintenance mode (System Settings) — the guard blocks
   user traffic while admins keep access.
2. Download the chosen archive from the backup bucket.
3. `pg_restore --no-owner -d "$DATABASE_URL" bb-<ts>.dump` into a **freshly created,
   empty** database — never over a live one. Then repoint `DATABASE_URL`.
4. Run the ledger integrity check (GET /api/admin/revenue/summary →
   `integrityOk` must be true) before disabling maintenance mode. A restore that
   loads without error but fails this check is a restore you must not serve
   from: the balances and the ledger disagree.
**Drill (required, staging):** restore last night's archive into a scratch
database and boot the app against it. An untested backup is not a backup — do
this once now, then quarterly.

## 3. Point-in-time recovery (item 46)
**Built (2026-10-24):** PostgreSQL archives every WAL segment to the private
backup bucket (`BACKUP_S3_BUCKET`, folder `pitr/`) through pgBackRest
(`deploy/vps/postgres/`: `archive_mode = on`, `archive_timeout = 60s`), and the
`pitr` service takes a base backup every day (full on Sundays, UTC). Two fulls
are kept: restore to any second of the last ~2 weeks. With `BACKUP_S3_BUCKET`
unset nothing is archived and nothing piles up on disk (`archive-wal.sh`); a
bucket that is unreachable queues at most 4 GiB locally, then drops segments
rather than fill the disk (`archive-push-queue-max`).

Check it is working: `docker compose -f docker-compose.prod.yml exec -u postgres pitr bb-pgbackrest --stanza=bb info`
(a recent backup, and a WAL range ending within the last minute or two).

**Restore to a moment** (e.g. just before a bad admin action at 14:03:10 IST):
1. Maintenance mode on, then stop everything that writes:
   `docker compose -f docker-compose.prod.yml stop api realtime scheduler scheduler-standby pitr postgres`.
2. Restore into the data volume, as the postgres user:
   `docker compose -f docker-compose.prod.yml run --rm -u postgres --entrypoint bb-pgbackrest postgres --stanza=bb --delta --type=time "--target=2026-10-24 14:03:10+05:30" --target-action=promote restore`
3. `docker compose -f docker-compose.prod.yml up -d` — PostgreSQL replays the
   archive to the target and opens. Its log says `recovery stopping before …`.
4. Ledger check as in §2 before maintenance mode goes off.

**Rehearse it** on a scratch server once now, then quarterly: the first restore
must not be during an incident. (Tested 2026-10-24 on PostgreSQL 16 with this
config and a local repository: a row written after the target was gone, the row
before it kept. Not yet tested against R2 or on the production image.)

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
- **Owner/admin:** DNS changes, `BACKUP_S3_BUCKET` + `PITR_CIPHER_PASS`, the database host (HIGH_AVAILABILITY.md), secret rotation,
  maintenance-mode toggle, restore approval.
- **Any operator:** §1 redeploys, §2 restore drill on staging, monitoring.
- Alerts arrive at the admin-configured webhook (System Settings →
  Operational Alerts); if that page is unreachable, `ALERT_WEBHOOK_URL` env is
  the fallback channel config.
