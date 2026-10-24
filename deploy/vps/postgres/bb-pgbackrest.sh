#!/bin/sh
# GOVERNANCE: Read CLAUDE.md before editing this file.
# pgBackRest with this deploy's environment (pitr-env.sh: the bare endpoint
# host, the cipher, no empty options). EVERY pgBackRest call goes through it,
# including the restore_command a restore writes (pgbackrest.conf `cmd`), since
# PostgreSQL runs that one itself during recovery. Operators use it too:
#   docker compose exec -u postgres pitr bb-pgbackrest --stanza=bb info
. "${BB_PITR_ENV:-/usr/local/lib/bb/pitr-env.sh}"
exec pgbackrest "$@"
