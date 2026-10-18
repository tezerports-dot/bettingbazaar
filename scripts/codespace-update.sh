#!/usr/bin/env bash
# GOVERNANCE: Read CLAUDE.md before editing this file.
#
# Bring a GitHub Codespace up to the latest `main`, check it, build it, and
# optionally build the Android APK. The same command every time:
#
#     bash scripts/codespace-update.sh          # pull, install, lint, unit tests, build
#     bash scripts/codespace-update.sh --apk    # all of the above, then the signed APK
#
# --apk runs the "Android release" GitHub workflow on main (the signing key
# lives in repository secrets, so the APK is built there, not in the Codespace),
# waits for it, and downloads app-release.apk into ./apk/ in this Codespace.
# Right-click it in the file explorer → Download, then upload it on the admin
# panel's Android App page.
#
# Other options:
#   --skip-checks   skip lint and unit tests
#   --apk-only      only build and download the APK
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WANT_APK=0; CHECKS=1; WEB=1
for a in "$@"; do
  case "$a" in
    --apk) WANT_APK=1 ;;
    --apk-only) WANT_APK=1; WEB=0; CHECKS=0 ;;
    --skip-checks) CHECKS=0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

# ── Pull main, then re-run the fresh copy of this script ─────────────────────
if [ -z "${BB_UPDATE_REEXEC:-}" ]; then
  bold "Pulling main"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    die "This Codespace has unsaved edits to tracked files (above). Commit them, or throw them away with 'git checkout -- .', then run this again."
  fi
  git fetch origin main
  git checkout -q main
  git merge --ff-only origin/main
  ok "On $(git log -1 --format='%h %s')"
  BB_UPDATE_REEXEC=1 exec bash "$ROOT/scripts/codespace-update.sh" "$@"
fi

if [ "$WEB" = 1 ]; then
  # Always --legacy-peer-deps: a plain `npm ci` fails on this repository.
  bold "Installing"
  npm ci --legacy-peer-deps
  npm run install:panels

  if [ "$CHECKS" = 1 ]; then
    bold "Lint and unit tests"
    npm run lint
    npx vitest run -c vitest.config.ts
    # Database tests need PostgreSQL, which a Codespace does not have; CI runs them.
  fi

  bold "Building the three panels"
  npm run build
  ok "Web build done"
fi

if [ "$WANT_APK" = 1 ]; then
  bold "Building the Android APK on GitHub"
  command -v gh >/dev/null || die "The GitHub CLI (gh) is missing. Run this in a GitHub Codespace."
  # The Codespace's built-in token cannot start workflows, so gh uses your own
  # sign-in. The first time, it shows a code to enter in the browser.
  GH=(env -u GITHUB_TOKEN gh)
  if ! "${GH[@]}" auth status >/dev/null 2>&1; then
    "${GH[@]}" auth login -h github.com -s repo,workflow -w
  fi
  REPO="$("${GH[@]}" repo view --json nameWithOwner -q .nameWithOwner)"
  VERSION="$(node -p "require('./user-panel/package.json').version")"

  if "${GH[@]}" release view "android-v$VERSION" -R "$REPO" >/dev/null 2>&1; then
    warn "Version $VERSION already has an APK on GitHub (release android-v$VERSION)."
    warn "The admin panel refuses an APK that is not newer than every published one."
    warn "To ship a new app version: raise \"version\" in user-panel/package.json, merge to main, run this again."
    if [ -t 0 ]; then
      read -r -p "Build $VERSION again anyway? [y/N] " ans
      case "$ans" in y|Y|yes) ;; *) die "Stopped, nothing built." ;; esac
    else
      die "Stopped, nothing built."
    fi
  fi

  HEAD_SHA="$(git rev-parse HEAD)"
  "${GH[@]}" workflow run android-release.yml -R "$REPO" --ref main
  echo "Started. Waiting for GitHub to list the run…"
  RUN_ID=""
  for _ in $(seq 1 30); do
    sleep 4
    RUN_ID="$("${GH[@]}" run list -R "$REPO" --workflow android-release.yml --event workflow_dispatch \
      --branch main -L 5 --json databaseId,headSha,status \
      -q "[.[] | select(.headSha==\"$HEAD_SHA\" and .status!=\"completed\")][0].databaseId // empty")"
    [ -n "$RUN_ID" ] && break
  done
  [ -n "$RUN_ID" ] || die "Could not find the run. Open GitHub → Actions → Android release to see it."

  echo "Building (usually 5–10 minutes): https://github.com/$REPO/actions/runs/$RUN_ID"
  "${GH[@]}" run watch "$RUN_ID" -R "$REPO" --exit-status --interval 20 >/dev/null \
    || die "The APK build failed. Its log: https://github.com/$REPO/actions/runs/$RUN_ID"

  rm -rf "$ROOT/apk" && mkdir -p "$ROOT/apk"
  "${GH[@]}" run download "$RUN_ID" -R "$REPO" -n "bettingbazaar-android-$VERSION" -D "$ROOT/apk"
  APK="$(find "$ROOT/apk" -name app-release.apk | head -1)"
  [ -n "$APK" ] || die "The run finished but no app-release.apk was downloaded."
  cp "$APK" "$ROOT/apk/bettingbazaar-$VERSION.apk"
  ok "APK ready: apk/bettingbazaar-$VERSION.apk  ($(du -h "$APK" | cut -f1))"
  echo "Also on GitHub: https://github.com/$REPO/releases/tag/android-v$VERSION"
  echo "Next: download it, then admin panel → Android App → upload → write What's new → Publish."
fi

bold "Done"
