#!/usr/bin/env bash
# rollback.sh — Revert to a pre-migration git checkpoint
#
# Usage:
#   bash tools/rollback.sh --repo-root PATH --branch BRANCH_NAME
#   bash tools/rollback.sh --branch pre-migration-all-20250101_120000

set -euo pipefail
RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; BOLD='\033[1m'; RESET='\033[0m'
err()  { echo -e "${RED}[ERR]${RESET}  $*" >&2; }
ok()   { echo -e "${GREEN}[OK]${RESET}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }

REPO_ROOT=""; BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root=*) REPO_ROOT="${1#--repo-root=}"; shift ;;
    --repo-root)   REPO_ROOT="$2"; shift 2 ;;
    --branch=*)    BRANCH="${1#--branch=}"; shift ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    *) err "Unknown: $1"; exit 1 ;;
  esac
done

if [[ -z "$REPO_ROOT" ]]; then
  candidate="$(pwd)"
  for _ in 1 2 3 4 5; do
    [[ -d "$candidate/backend" ]] && { REPO_ROOT="$candidate"; break; }
    candidate="$(dirname "$candidate")"
  done
fi

[[ -z "$REPO_ROOT" ]] && { err "Cannot locate repo root. Use --repo-root"; exit 1; }
[[ -z "$BRANCH"    ]] && { err "--branch is required (e.g. pre-migration-all-20250101_120000)"; exit 1; }

cd "$REPO_ROOT"
echo -e "${BOLD}Rollback to: $BRANCH${RESET}"

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  err "Not a git repository: $REPO_ROOT"; exit 1
fi
if ! git rev-parse --verify "$BRANCH" &>/dev/null; then
  err "Branch not found: $BRANCH"; exit 1
fi

CURRENT=$(git rev-parse --abbrev-ref HEAD)
warn "This will reset $CURRENT to match $BRANCH."
read -r -p "Type 'yes' to continue: " confirm
[[ "$confirm" == "yes" ]] || { warn "Aborted"; exit 0; }

git checkout "$BRANCH"
git checkout -b "rollback-$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
ok "Rolled back to $BRANCH"
echo "State file preserved — reset with: rm tools/.migration-state.json"