#!/usr/bin/env bash
# GOVERNANCE: Read CLAUDE.md before editing this file.
#
# Update the Hostinger server to the latest `main`. The same command every time:
#
#     cd /var/www/bettingbazaar && git pull origin main && bash deploy/vps/update.sh
#
# Safe to run again and again; it only does work when something changed.
#   1. stops if files tracked by git were edited on the server
#   2. pulls main (fast-forward only), then re-runs itself so the newest copy
#      of this script is the one doing the deploy
#   3. warns about settings added to .env.template since the last deploy that
#      your .env does not have yet, and asks before carrying on
#   4. rebuilds and restarts the stack; the `migrate` service applies the
#      database schema itself, so there is no separate migration step; and
#      recreates caddy when Caddyfile.vps changed (see below)
#   5. checks migrate exited 0, the containers are up, and /health/ready answers
#   6. removes dangling images left by the rebuild (old layers fill the disk)
#
# Options:  --yes   do not stop to ask about new settings (still prints them)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.prod.yml")
STAMP="$HOME/.bettingbazaar-last-deploy"
ASSUME_YES=0
for a in "$@"; do [ "$a" = "--yes" ] && ASSUME_YES=1; done

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

# ── 1 + 2. Pull main, then re-run the fresh copy of this script ──────────────
if [ -z "${BB_UPDATE_REEXEC:-}" ]; then
  bold "Pulling main"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    die "Files tracked by git were changed on this server (above). Undo them with 'git checkout -- <file>' or commit them from GitHub instead, then run this again."
  fi
  git fetch origin main
  git checkout -q main
  git merge --ff-only origin/main
  ok "On $(git log -1 --format='%h %s')"
  BB_UPDATE_REEXEC=1 exec bash "$HERE/update.sh" "$@"
fi

[ -f "$HERE/.env" ] || die "deploy/vps/.env is missing. Make it once: cd deploy/vps && cp .env.template .env && nano .env && chmod 600 .env"

# ── 3. New settings since the last deploy ─────────────────────────────────────
bold "Checking for new settings"
PREV=""
[ -f "$STAMP" ] && PREV="$(cat "$STAMP")"
keys_in() { grep -oE '^[A-Z][A-Z0-9_]*=' "$1" | tr -d '=' | sort -u; }
NEW_KEYS=""
if [ -n "$PREV" ] && git cat-file -e "$PREV^{commit}" 2>/dev/null; then
  NEW_KEYS="$(comm -13 <(git show "$PREV:deploy/vps/.env.template" 2>/dev/null | keys_in /dev/stdin) <(keys_in "$HERE/.env.template"))"
  echo "Changes since the last deploy ($(git log -1 --format=%h "$PREV")):"
  git log --oneline "$PREV..HEAD" | head -30
else
  echo "(first run of this script: comparing your .env with the whole template)"
  NEW_KEYS="$(keys_in "$HERE/.env.template")"
fi
MISSING=""
for k in $NEW_KEYS; do
  grep -qE "^$k=" "$HERE/.env" || MISSING="$MISSING $k"
done
if [ -n "$MISSING" ]; then
  warn "These settings are in .env.template but not in your .env:"
  for k in $MISSING; do echo "    $k"; done
  warn "Read what each one is in deploy/vps/.env.template (grep -n -B4 NAME deploy/vps/.env.template)."
  warn "Many are optional and fine to leave out; a required one stops the api from starting."
  if [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
    read -r -p "Carry on with the deploy? [y/N] " ans
    case "$ans" in y|Y|yes) ;; *) die "Stopped. Add the settings to deploy/vps/.env, then run this again." ;; esac
  fi
else
  ok "No new settings needed"
fi

# ── 4. Build and restart (migrate runs inside this) ───────────────────────────
bold "Building and restarting (this takes a few minutes)"
"${COMPOSE[@]}" up -d --build --remove-orphans

# Caddyfile.vps is mounted as a single file. `git pull` replaces the file, but a
# running container keeps the one it was started with, so a header or route
# change never reached the live site (outside checks, 2026-10-15: no
# Permissions-Policy, `Via: 1.1 Caddy` still sent). Recreate caddy when the file
# it is serving differs from the one in git: a second or two without answers.
if ! "${COMPOSE[@]}" exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$HERE/Caddyfile.vps"; then
  bold "Caddyfile.vps changed: recreating caddy"
  "${COMPOSE[@]}" up -d --force-recreate --no-deps caddy
  ok "caddy is serving the Caddyfile in git"
else
  ok "caddy already serves the Caddyfile in git"
fi

# ── 5. Checks ─────────────────────────────────────────────────────────────────
bold "Checking it came up"
MIG_ID="$("${COMPOSE[@]}" ps -aq migrate | head -1)"
if [ -n "$MIG_ID" ]; then
  # Wait for the one-shot migrate container to finish (normally seconds).
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Running}}' "$MIG_ID")" = "false" ] && break
    sleep 2
  done
  CODE="$(docker inspect -f '{{.State.ExitCode}}' "$MIG_ID")"
  if [ "$CODE" != "0" ]; then
    "${COMPOSE[@]}" logs migrate --tail=50
    die "The database schema step (migrate) failed with exit code $CODE. Its log is above."
  fi
  ok "Database schema applied"
fi

"${COMPOSE[@]}" ps

ORIGIN="$(grep -E '^PUBLIC_APP_ORIGIN=' "$HERE/.env" | tail -1 | cut -d= -f2- | tr -d '\r')"
if [ -n "$ORIGIN" ]; then
  HEALTHY=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$ORIGIN/health/ready" >/dev/null 2>&1; then HEALTHY=1; break; fi
    sleep 4
  done
  if [ "$HEALTHY" = 1 ]; then
    ok "$ORIGIN/health/ready answers"
  else
    "${COMPOSE[@]}" logs api --tail=60
    die "$ORIGIN/health/ready did not answer within 2 minutes. The api log is above."
  fi
else
  warn "PUBLIC_APP_ORIGIN is not set in .env, so the health check was skipped."
fi

# ── 6. Tidy up ────────────────────────────────────────────────────────────────
docker image prune -f >/dev/null || true
git rev-parse HEAD > "$STAMP"

bold "Deployed $(git log -1 --format='%h %s')"
