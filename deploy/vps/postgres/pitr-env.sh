# GOVERNANCE: Read CLAUDE.md before editing this file.
# Sourced by archive-wal.sh and pitr-backup-loop.sh: is point-in-time recovery
# configured, and the environment pgBackRest wants.

# On when a bucket is named (or, in a test, a non-S3 repository is chosen).
pitr_enabled() {
  [ -n "${PGBACKREST_REPO1_S3_BUCKET:-}" ] || [ "${PGBACKREST_REPO1_TYPE:-s3}" != "s3" ]
}

# The app's S3 endpoint carries a scheme (https://<account>.r2.cloudflarestorage.com);
# pgBackRest wants the bare host.
if [ -n "${PGBACKREST_REPO1_S3_ENDPOINT:-}" ]; then
  PGBACKREST_REPO1_S3_ENDPOINT=${PGBACKREST_REPO1_S3_ENDPOINT#https://}
  PGBACKREST_REPO1_S3_ENDPOINT=${PGBACKREST_REPO1_S3_ENDPOINT#http://}
  PGBACKREST_REPO1_S3_ENDPOINT=${PGBACKREST_REPO1_S3_ENDPOINT%%/*}
  export PGBACKREST_REPO1_S3_ENDPOINT
fi

# Encrypted when PITR_CIPHER_PASS is set (compose maps it here). Decide BEFORE the
# first backup: a repository's cipher cannot change afterwards.
if [ -n "${PGBACKREST_REPO1_CIPHER_PASS:-}" ]; then
  export PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
else
  unset PGBACKREST_REPO1_CIPHER_PASS
fi

# Compose passes every mapped option, set or not; an empty one is not an answer.
for v in PGBACKREST_REPO1_S3_KEY PGBACKREST_REPO1_S3_KEY_SECRET PGBACKREST_REPO1_S3_REGION PGBACKREST_PG1_USER; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || unset "$v"
done
