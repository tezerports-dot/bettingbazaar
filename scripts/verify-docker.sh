#!/usr/bin/env bash
# GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
# =============================================================================
# verify-docker.sh — prove the container image actually works.
# =============================================================================
#
# ── Why this exists ─────────────────────────────────────────────────────────
# CI builds no image. Every claim about the Dockerfile — that the data layer is
# in it, that `#db` resolves, that the PostgreSQL client tools match the server,
# that the thing boots at all — was read off the Dockerfile rather than observed.
# A Dockerfile that reads correctly and produces an image that dies at module
# load looks identical from the source.
#
# Two of those claims had already been wrong: `COPY database ./database` was
# missing (every `import { db } from '#db'` would have thrown at startup), and
# the image carried a PostgreSQL 15 client against an 18 server, which
# `pg_dump` refuses — the nightly backup would have degraded to a logged skip
# with nobody looking.
#
# So this script does not read anything. It builds the image cold, runs it
# against a real PostgreSQL 18 and a real Redis, and asks the running container
# the questions. Each answer prints PASS or FAIL and the script exits non-zero
# if any failed.
#
# ── Where to run it ─────────────────────────────────────────────────────────
# Anywhere with a Docker daemon and egress to Docker Hub: a laptop, a GitHub
# Codespace, a self-hosted runner. It is deliberately NOT wired into CI yet —
# a cold no-cache build of three frontends is several minutes, and this is a
# release-gate check, not a per-push one.
#
#   bash scripts/verify-docker.sh
#
# Writes nothing to the repository and removes every container it starts.
# =============================================================================
set -uo pipefail

IMAGE=bettingbazaar:verify
NET=bbverify
PGC=bbpg
REDISC=bbredis
APPC=bbapp
TMP=$(mktemp -d)
PASS=0; FAIL=0
ok()   { echo "  ✅ PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL  $*"; FAIL=$((FAIL+1)); }
step() { echo; echo "═══ $* ═══"; }

cleanup() {
  docker rm -f "$APPC" "$PGC" "$REDISC" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

step "0. Environment"
docker version --format 'Docker {{.Server.Version}}' || {
  echo "  ❌ No Docker daemon reachable. This script cannot verify anything without one."
  echo "     VERDICT: UNVERIFIED"; exit 2; }
echo "branch: $(git rev-parse --abbrev-ref HEAD)  commit: $(git rev-parse --short HEAD)"
df -h . | tail -1

step "1. Build the image (--no-cache: a real cold build, not a cache illusion)"
time docker build --no-cache --progress=plain -t "$IMAGE" . 2>&1 | tail -40
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  ok "docker build completed"
  echo "     size: $(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}')"
  # A money process that runs as root turns any RCE into host compromise.
  if [ "$(docker image inspect "$IMAGE" --format '{{.Config.User}}')" = "node" ]; then
    ok "runtime user is non-root (node)"
  else
    bad "runtime user is '$(docker image inspect "$IMAGE" --format '{{.Config.User}}')', expected node"
  fi
else
  bad "docker build did not produce an image"
  echo; echo "  checks passed: $PASS    failed: $FAIL"; echo "  VERDICT: FAIL"; exit 1
fi

step "2. PostgreSQL client tools are present, at the SERVER's major version"
# pg_dump refuses a server newer than itself. A 15 client against an 18 server
# fails with "server version mismatch", and backup.service.js catches that and
# logs a skip — so the failure is silent and the backups simply stop existing.
docker run --rm "$IMAGE" sh -c 'pg_dump --version; pg_restore --version; psql --version' > "$TMP/pgv.txt" 2>&1
cat "$TMP/pgv.txt"
grep -q 'pg_dump (PostgreSQL) 18' "$TMP/pgv.txt" \
  && ok "pg_dump is 18.x — it can dump an 18 server" \
  || bad "pg_dump missing or not 18.x — the nightly backup would degrade to a logged skip"
grep -q 'pg_restore (PostgreSQL) 18' "$TMP/pgv.txt" \
  && ok "pg_restore is 18.x — the restore drill can run" \
  || bad "pg_restore missing or not 18.x — a backup nobody can restore is not a backup"

step "3. The data layer was actually COPYed into the image"
docker run --rm "$IMAGE" sh -c '
  ls -la /app/database/index.js /app/database/client.js /app/database/schema.sql 2>&1
  echo "repositories: $(ls /app/database/repositories | wc -l)"
  echo "migrations:   $(ls /app/database/migrations | wc -l)"
  echo "spec:         $(ls /app/database/spec | wc -l)"
' > "$TMP/dbls.txt" 2>&1
cat "$TMP/dbls.txt"
grep -q '/app/database/index.js'  "$TMP/dbls.txt" && ok "database/index.js present"  || bad "database/ was NOT copied into the image"
grep -q '/app/database/client.js' "$TMP/dbls.txt" && ok "database/client.js present" || bad "database/client.js missing"
grep -q '/app/database/schema.sql' "$TMP/dbls.txt" && ok "schema.sql present — boot applies it" || bad "schema.sql missing; boot would fail on the first table"
[ "$(sed -n 's/^repositories: //p' "$TMP/dbls.txt")" -ge 40 ] 2>/dev/null \
  && ok "every repository module present" || bad "repository modules missing"
[ "$(sed -n 's/^migrations: *//p' "$TMP/dbls.txt")" -ge 1 ] 2>/dev/null \
  && ok "migrations/ present" || bad "migrations/ missing"

step "4. The #db subpath import resolves INSIDE the container"
# The one that fails at module load if database/ is absent — which is to say,
# on the first request of a production deploy, not in any test.
docker run --rm "$IMAGE" node -e "
  import('#db')
    .then(m => console.log('namespaces:', Object.keys(m.db).length, '->', Object.keys(m.db).slice(0, 6).join(',')))
    .catch(e => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
" > "$TMP/dbimp.txt" 2>&1
cat "$TMP/dbimp.txt"
grep -q 'namespaces:' "$TMP/dbimp.txt" \
  && ok "the #db front door resolves in the image" \
  || bad "#db does not resolve — the container cannot serve a single request"

step "5. Boot the container for real, against a real PostgreSQL 18"
docker network create "$NET" >/dev/null 2>&1
docker run -d --name "$PGC" --network "$NET" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bb_verify \
  postgres:18 >/dev/null
docker run -d --name "$REDISC" --network "$NET" redis:7-alpine >/dev/null
printf 'waiting for postgres'
for _ in $(seq 1 60); do
  docker exec "$PGC" pg_isready -U postgres >/dev/null 2>&1 && break
  printf .; sleep 1
done; echo ' up'

# Every REQUIRED name in backend/startup/validateEnv.js, at production strength:
# with NODE_ENV=production a missing or weak one THROWS at boot, which is the
# behaviour being tested rather than worked around.
#
#   PG_SSL=false          resolvePgSsl() only skips TLS for localhost/127.0.0.1.
#                         The sidecar is reached by hostname, so without this the
#                         pool demands verified TLS and the connection dies.
#   PUBLIC_APP_ORIGIN     must be https:// — isOrigin() runs with requireHttps
#                         in production and an http:// origin aborts boot.
#   S3_*                  isS3Configured() is a presence check; nothing here
#                         uploads, so placeholders are honest.
docker run -d --name "$APPC" --network "$NET" -p 8080:8080 \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -e DATABASE_URL="postgresql://postgres:postgres@$PGC:5432/bb_verify" \
  -e PG_SSL=false \
  -e REDIS_URL="redis://$REDISC:6379" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e ORDER_HMAC_SECRET="$(openssl rand -hex 32)" \
  -e AADHAAR_HMAC_SECRET="$(openssl rand -hex 32)" \
  -e IDENTITY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e METRICS_TOKEN="$(openssl rand -hex 32)" \
  -e ALLOWED_ORIGINS="https://app.example.com" \
  -e PUBLIC_APP_ORIGIN="https://app.example.com" \
  -e PUBLIC_APP_ALLOWED_ORIGINS="https://app.example.com" \
  -e S3_BUCKET_NAME=verify-bucket \
  -e S3_ACCESS_KEY=verify-access-key \
  -e S3_SECRET_KEY=verify-secret-key \
  -e S3_ENDPOINT=https://s3.example.com \
  "$IMAGE" >/dev/null

printf 'waiting for /health/ready'
READY=no
for _ in $(seq 1 90); do
  code=$(curl -s -o "$TMP/ready.json" -w '%{http_code}' http://127.0.0.1:8080/health/ready 2>/dev/null)
  [ "$code" = "200" ] && { READY=yes; break; }
  docker inspect -f '{{.State.Running}}' "$APPC" 2>/dev/null | grep -q true || break
  printf .; sleep 1
done; echo

echo "── container logs (tail) ──"
docker logs "$APPC" 2>&1 | tail -45
echo "───────────────────────────"

if [ "$READY" = yes ]; then
  ok "container booted and /health/ready returned 200"
  echo "     $(cat "$TMP/ready.json")"
  # Readiness is a real SELECT 1 round trip (isDatabaseReachable), not a pool flag.
  grep -q 'connected' "$TMP/ready.json" \
    && ok "readiness reports the money database connected" \
    || bad "readiness answered 200 without reporting a live database"
else
  bad "container never became ready — see the logs above"
fi

step "6. The schema really was applied to a live server"
docker exec "$PGC" psql -U postgres -d bb_verify -tAc \
  'SELECT count(*) FROM information_schema.tables WHERE table_schema = $q$public$q$;' > "$TMP/tbl.txt" 2>&1
TABLES=$(tr -d '[:space:]' < "$TMP/tbl.txt")
echo "  public tables created: $TABLES"
[ "${TABLES:-0}" -ge 60 ] 2>/dev/null \
  && ok "applySchema() ran against a real server ($TABLES tables)" \
  || bad "schema was not applied (found '$TABLES' tables)"
docker exec "$PGC" psql -U postgres -d bb_verify -tAc \
  'SELECT string_agg(table_name, $q$, $q$ ORDER BY table_name) FROM information_schema.tables
    WHERE table_schema = $q$public$q$ AND table_name IN
    ($q$users$q$, $q$wallets$q$, $q$wallet_ledger$q$, $q$bets$q$,
     $q$order_states$q$, $q$order_transitions$q$, $q$cycles$q$, $q$deposit_policies$q$);' 2>&1 \
  | sed 's/^/  money tables: /'

step "7. Liveness, HEALTHCHECK, and the built frontends"
docker inspect "$APPC" --format '  healthcheck: {{if .State.Health}}{{.State.Health.Status}}{{else}}(still starting){{end}}'
curl -s -o /dev/null -w '  /health/live -> %{http_code}\n' http://127.0.0.1:8080/health/live
curl -s -o /dev/null -w '  /            -> %{http_code}\n' http://127.0.0.1:8080/
# The multi-stage split is only worth its complexity if the build tooling really
# stayed behind in the builder stage.
docker run --rm "$IMAGE" sh -c '
  echo "  user dist:     $(ls /app/dist | wc -l) entries"
  echo "  admin dist:    $(ls /app/admin-panel/dist | wc -l) entries"
  echo "  merchant dist: $(ls /app/merchant-panel/dist | wc -l) entries"
  echo "  build tooling left in runtime node_modules: vite=$(ls /app/node_modules | grep -cx vite) vitest=$(ls /app/node_modules | grep -cx vitest)"
'

echo
echo "═══════════════════════════════════════"
echo "  checks passed: $PASS    failed: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  VERDICT: PASS"
else
  echo "  VERDICT: FAIL"
fi
echo "═══════════════════════════════════════"
[ "$FAIL" -eq 0 ]
