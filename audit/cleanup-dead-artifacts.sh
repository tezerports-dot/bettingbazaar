#!/usr/bin/env bash
# audit/cleanup-dead-artifacts.sh
#
# Removes explicitly listed dead artifacts after confirming no live references.
# Every target was verified via grep to have zero importers/references before
# being added to this list. Safe to re-run (idempotent — skips anything already gone).
#
# Defaults to --dry-run. Nothing is deleted unless you pass --apply.
#
# Usage:
#   bash audit/cleanup-dead-artifacts.sh                # dry run, lists what would happen
#   bash audit/cleanup-dead-artifacts.sh --apply         # actually deletes
#   bash audit/cleanup-dead-artifacts.sh --apply --include-002-migration
#                                                         # also deletes backend/migrations/002-fix-everything.js
#                                                         # ONLY pass this after
#                                                         # audit/verify-merchant-status-integrity.mjs
#                                                         # reports zero mismatches against production.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APPLY=false
INCLUDE_002=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --include-002-migration) INCLUDE_002=true ;;
  esac
done

GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[INFO]${RESET} $*"; }
skip()  { echo -e "${YELLOW}[SKIP]${RESET} $* (already gone)"; }
act()   { echo -e "${GREEN}[$([ "$APPLY" = true ] && echo DELETE || echo WOULD-DELETE)]${RESET} $*"; }

TARGETS=(
  "migration-files"
  "payment-migration.zip"
  "payment-migration.patch"
)

if [ "$INCLUDE_002" = true ]; then
  TARGETS+=("backend/migrations/002-fix-everything.js")
fi

info "Repo root: $REPO_ROOT"
info "Mode: $([ "$APPLY" = true ] && echo APPLY || echo DRY-RUN)"
echo ""

for target in "${TARGETS[@]}"; do
  if [ ! -e "$target" ]; then
    skip "$target"
    continue
  fi

  # Re-verify zero references right before acting, in case the repo changed since the audit.
  refs=$(grep -rl "$(basename "$target")" --include="*.js" --include="*.ts" --include="*.tsx" --include="*.json" . 2>/dev/null \
    | grep -v "^\./$target" | grep -v node_modules | grep -v "audit/cleanup-dead-artifacts.sh" || true)

  if [ -n "$refs" ]; then
    echo -e "${YELLOW}[BLOCKED]${RESET} $target — found references, refusing to delete:"
    echo "$refs" | sed 's/^/    /'
    continue
  fi

  act "$target"
  if [ "$APPLY" = true ]; then
    rm -rf "$target"
  fi
done

echo ""
if [ "$APPLY" = false ]; then
  info "Dry run complete. Re-run with --apply to actually delete."
fi
if [ "$INCLUDE_002" = false ]; then
  info "backend/migrations/002-fix-everything.js NOT included — run audit/verify-merchant-status-integrity.mjs against production first."
fi
