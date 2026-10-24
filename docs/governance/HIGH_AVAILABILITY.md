# High availability — not one server for everything

**Problem (security & reliability review, 2026-10-24):** `deploy/vps/docker-compose.prod.yml`
runs PostgreSQL, PgBouncer, Redis, Caddy and every app process on ONE machine. If
that machine, its disk or its data centre fails, the whole platform is down and
the money records on it are at risk.

What is already covered in the repo, and what needs the owner:

| Failure | Covered by | Owner action |
| --- | --- | --- |
| The round manager process crashes or freezes | `scheduler-standby` takes over within 15 s (`cycle-manager` lease, CLAUDE.md §36) | none |
| Data lost or corrupted | Nightly `pg_dump` + continuous WAL archive: restore to any second of the last ~2 weeks (DISASTER_RECOVERY.md §2–3) | set `BACKUP_S3_BUCKET` and `PITR_CIPHER_PASS` |
| The database server dies | **Option A or B below** | buy one of them |
| The app server dies | A second app server + DNS failover (DISASTER_RECOVERY.md §4) | buy a second server |

## Option A (recommended): a managed PostgreSQL

The provider runs the database with a standby copy in another zone, switches to
it automatically, and keeps its own point-in-time backups. Nothing to operate.

**What to buy:** managed PostgreSQL **16 or newer**, with **high availability /
standby replica** switched on, **point-in-time recovery** switched on, the
**`vector` extension** available (the support assistant's search), a
**transaction-mode connection pooler**, and a region close to the app server.
Size to start: 4 vCPU / 16 GB, matching `deploy/vps/postgres/postgresql.conf`.

**Move (the platform is not live yet, so this is a copy, not a migration):**

1. Create the database and its user at the provider; download its CA certificate.
2. In `deploy/vps/.env` set `MANAGED_DATABASE_URL` (pooled URL),
   `MANAGED_DIRECT_DATABASE_URL` (direct URL) and `PG_CA_CERT` (the PEM, one line
   with `\n`), and keep `BACKUP_S3_BUCKET` for the provider-independent nightly dump.
3. Maintenance mode on. Copy the data:
   `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -Fc -U bb bettingbazaar > bb.dump`
   then `pg_restore --no-owner -d "$MANAGED_DIRECT_DATABASE_URL" bb.dump`.
4. Start against it:
   `docker compose -f docker-compose.prod.yml -f docker-compose.managed-db.yml up -d --build`.
   The local postgres, pitr and pgbouncer no longer start.
5. Ledger check (`GET /api/admin/revenue/summary` → `integrityOk: true`), then
   maintenance mode off. Keep the old volume until a week of good backups exists.

## Option B: a replica on a second server you run

A second VPS keeps a live copy (PostgreSQL streaming replication, `wal_level =
replica` and `max_wal_senders` are already set in `postgresql.conf`). Promotion
when the primary dies is a manual step (`SELECT pg_promote();` on the replica,
then point `DATABASE_URL` and PgBouncer at it), so there is a gap of minutes and
someone must be awake to do it. It also needs the replication port opened only
on the WireGuard link between the two servers (`deploy/vps/wireguard/`). More
work and more risk than Option A for the same protection; choose it only if a
managed provider is not possible.

## What this does not cover

Redis and Caddy stay on the app server. Redis holds no money (rate-limit
counters, realtime fan-out, the job queue) and restarts empty safely; losing the
app server is the DNS failover in DISASTER_RECOVERY.md §4.
