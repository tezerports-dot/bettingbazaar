# GOVERNANCE: Read CLAUDE.md before editing this file.
# PostgreSQL 18 + pgvector (as before) + pgBackRest, for point-in-time recovery:
# every WAL segment is shipped to the private backup bucket as it is written
# (archive-wal.sh), and a base backup is taken every day (pitr-backup-loop.sh,
# the `pitr` service). Restore to any second: docs/governance/DISASTER_RECOVERY.md §3.
FROM pgvector/pgvector:pg18
# ca-certificates: the base image has no CA bundle, and without it pgBackRest
# cannot verify the bucket's TLS certificate ("unable to get local issuer
# certificate"). The archive script's name must contain "pgbackrest":
# `pgbackrest check` refuses an archive_command that does not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/local/lib/bb
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY pitr-env.sh /usr/local/lib/bb/pitr-env.sh
COPY archive-wal.sh /usr/local/bin/bb-pgbackrest-archive-wal
COPY bb-pgbackrest.sh /usr/local/bin/bb-pgbackrest
COPY pitr-backup-loop.sh /usr/local/bin/bb-pitr-backup-loop
RUN chmod 0644 /etc/pgbackrest/pgbackrest.conf /usr/local/lib/bb/pitr-env.sh \
 && chmod 0755 /usr/local/bin/bb-pgbackrest-archive-wal /usr/local/bin/bb-pgbackrest /usr/local/bin/bb-pitr-backup-loop
