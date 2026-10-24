#!/bin/sh
# GOVERNANCE: Read CLAUDE.md before editing this file.
# PostgreSQL's archive_command (postgresql.conf): ship one WAL segment.
#
# With no backup bucket configured this reports success and ships nothing, so
# PostgreSQL recycles the segment exactly as it did with archive_mode=off. A
# failing archive_command makes PostgreSQL KEEP every segment, and an unarchived
# backlog fills the disk and takes the database down.
. "${BB_PITR_ENV:-/usr/local/lib/bb/pitr-env.sh}"
pitr_enabled || exit 0
exec pgbackrest --stanza=bb archive-push "$1"
