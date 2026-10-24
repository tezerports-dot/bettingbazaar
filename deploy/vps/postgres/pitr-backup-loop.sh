#!/bin/sh
# GOVERNANCE: Read CLAUDE.md before editing this file.
# The `pitr` service: create the repository once, then one base backup a day —
# FULL on Sundays (UTC) or when none exists, DIFFERENTIAL otherwise. With the
# continuous WAL archive this gives restore to any second (DISASTER_RECOVERY.md §3).
set -u
. "${BB_PITR_ENV:-/usr/local/lib/bb/pitr-env.sh}"

if ! pitr_enabled; then
  echo "[pitr] OFF: BACKUP_S3_BUCKET is not set, so WAL is not archived and no base backup is taken."
  exec sleep infinity
fi
[ -n "${PGBACKREST_REPO1_CIPHER_PASS:-}" ] \
  || echo "[pitr] WARNING: PITR_CIPHER_PASS is not set; the archive in the bucket is NOT encrypted."

SOCKET="${PGBACKREST_PG1_SOCKET_PATH:-/var/run/postgresql}"
MARK_DIR="${BB_PITR_MARK_DIR:-/var/lib/postgresql/pgbackrest-spool}"
mkdir -p "$MARK_DIR"
until pg_isready -h "$SOCKET" -q; do echo "[pitr] waiting for PostgreSQL…"; sleep 5; done

# Idempotent: a repository that exists and matches is left as it is. Retried
# every loop until it works, so a bucket that was unreachable at start (or a
# setting fixed later) needs no restart of this service.
ready=0
while true; do
  if [ "$ready" = 0 ]; then
    if pgbackrest --stanza=bb stanza-create; then
      ready=1
      pgbackrest --stanza=bb check || echo "[pitr] ERROR: check failed — WAL is not reaching the bucket."
    else
      echo "[pitr] ERROR: stanza-create failed — see above. Retrying in ${BB_PITR_LOOP_SECONDS:-3600} s."
      sleep "${BB_PITR_LOOP_SECONDS:-3600}"
      continue
    fi
  fi
  today=$(date -u +%F)
  if [ "$(cat "$MARK_DIR/last-backup" 2>/dev/null)" != "$today" ]; then
    # pgBackRest promotes a diff to a full when no full exists yet.
    type=diff; [ "$(date -u +%u)" = "7" ] && type=full
    echo "[pitr] $type backup starting"
    if pgbackrest --stanza=bb --type="$type" backup; then
      echo "$today" > "$MARK_DIR/last-backup"
      echo "[pitr] $type backup done"
    else
      echo "[pitr] ERROR: $type backup FAILED — retrying in an hour."
    fi
  fi
  sleep "${BB_PITR_LOOP_SECONDS:-3600}"
done
