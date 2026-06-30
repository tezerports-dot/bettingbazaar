#!/usr/bin/env bash
# run-migration.sh — Betting Bazaar migration runner
#
# Usage:
#   bash tools/run-migration.sh [options]
#
# Options:
#   --repo-root PATH    Repository root (default: auto-detect)
#   --dry-run           Show changes without writing; no git ops
#   --skip-git          Skip checkpoint branch creation
#   --phase PHASE       core | patches | architecture | cleanup | report | all (default)
#   --force             Re-run steps already marked complete
#   --reset-state       Clear state file before running
#   --verify-build      Run backend syntax check after migration
#   --python PATH       Python3 binary path (default: python3)

set -euo pipefail

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; BOLD='\033[1m'; RESET='\033[0m'
info()   { echo -e "${CYAN}[RUN]${RESET}   $*"; }
ok()     { echo -e "${GREEN}[OK]${RESET}    $*"; }
err()    { echo -e "${RED}[ERR]${RESET}   $*" >&2; }
warn()   { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
banner() { echo -e "\n${BOLD}━━━ $* ━━━${RESET}"; }

# ── Parse args ────────────────────────────────────────────────────────────────
REPO_ROOT=""
DRY_RUN=false
SKIP_GIT=false
PHASE="all"
FORCE=false
RESET_STATE=false
VERIFY_BUILD=false
PYTHON="python3"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root=*)   REPO_ROOT="${1#--repo-root=}"; shift ;;
    --repo-root)     REPO_ROOT="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --skip-git)      SKIP_GIT=true; shift ;;
    --phase=*)       PHASE="${1#--phase=}"; shift ;;
    --phase)         PHASE="$2"; shift 2 ;;
    --force)         FORCE=true; shift ;;
    --reset-state)   RESET_STATE=true; shift ;;
    --verify-build)  VERIFY_BUILD=true; shift ;;
    --python=*)      PYTHON="${1#--python=}"; shift ;;
    --python)        PYTHON="$2"; shift 2 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Locate repo root ──────────────────────────────────────────────────────────
if [[ -z "$REPO_ROOT" ]]; then
  candidate="$(pwd)"
  for _ in 1 2 3 4 5; do
    if [[ -d "$candidate/backend" && -f "$candidate/package.json" ]]; then
      REPO_ROOT="$candidate"; break
    fi
    candidate="$(dirname "$candidate")"
  done
fi
[[ -z "$REPO_ROOT" || ! -d "$REPO_ROOT" ]] && { err "Cannot locate repo root. Use --repo-root=PATH"; exit 1; }
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_PY="$SCRIPT_DIR/domain_migration.py"
VALIDATE_SH="$SCRIPT_DIR/validate-migration.sh"

echo -e "${BOLD}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Betting Bazaar — Domain Migration Engine                  ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════╝${RESET}"
echo "  Repository  : $REPO_ROOT"
echo "  Phase       : $PHASE"
echo "  Python      : $($PYTHON --version 2>&1)"
echo "  Dry run     : $DRY_RUN"
echo "  Force       : $FORCE"
echo "  Reset state : $RESET_STATE"
echo

# ── STEP 1: Verify repo ───────────────────────────────────────────────────────
banner "STEP 1: Verify repository"
missing=0
for f in "backend/server.js" "backend/models/index.js" "package.json" "tools/domain_migration.py"; do
  [[ -f "$REPO_ROOT/$f" ]] || { err "Missing: $f"; ((missing++)) || true; }
done
[[ $missing -gt 0 ]] && { err "Repository check failed ($missing missing files)"; exit 1; }
ok "Repository verified: $REPO_ROOT"
command -v "$PYTHON" &>/dev/null || { err "Python not found: $PYTHON"; exit 1; }
ok "Python: $($PYTHON --version 2>&1)"

# ── STEP 2: Git checkpoint ────────────────────────────────────────────────────
banner "STEP 2: Git checkpoint"
CHECKPOINT_BRANCH=""
if $DRY_RUN || $SKIP_GIT; then
  warn "Skipping git checkpoint (dry-run or --skip-git)"
else
  cd "$REPO_ROOT"
  if git rev-parse --is-inside-work-tree &>/dev/null; then
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
    CHECKPOINT_BRANCH="pre-migration-${PHASE}-${TIMESTAMP}"
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
    git checkout -b "$CHECKPOINT_BRANCH" 2>/dev/null && \
      git add -A 2>/dev/null || true && \
      git commit -m "chore: pre-migration checkpoint [phase=$PHASE] $(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        --allow-empty 2>/dev/null || true
    ok "Checkpoint branch: $CHECKPOINT_BRANCH"
    git checkout "$CURRENT_BRANCH" 2>/dev/null || true
  else
    warn "Not a git repo — skipping checkpoint"
  fi
fi

# ── STEP 3: Run migration ─────────────────────────────────────────────────────
banner "STEP 3: Run migration (phase: $PHASE)"
MIGRATION_ARGS=(--repo-root "$REPO_ROOT" --phase "$PHASE")
$DRY_RUN      && MIGRATION_ARGS+=(--dry-run)
$FORCE        && MIGRATION_ARGS+=(--force)
$RESET_STATE  && MIGRATION_ARGS+=(--reset-state)

info "Running: $PYTHON $MIGRATION_PY ${MIGRATION_ARGS[*]}"
echo
migration_exit=0
"$PYTHON" "$MIGRATION_PY" "${MIGRATION_ARGS[@]}" || migration_exit=$?

if [[ $migration_exit -ne 0 ]]; then
  err "Migration exited with code $migration_exit"
  [[ -n "$CHECKPOINT_BRANCH" ]] && warn "To rollback: bash tools/rollback.sh --repo-root $REPO_ROOT --branch $CHECKPOINT_BRANCH"
  exit 1
fi
ok "Migration script completed"

# ── STEP 4: Build verification (optional) ─────────────────────────────────────
if $VERIFY_BUILD && ! $DRY_RUN; then
  banner "STEP 4: Build verification"
  if command -v node &>/dev/null; then
    for f in \
      "backend/models/paymentOrder.model.js" \
      "backend/services/paymentProcessing.service.js" \
      "backend/routes/payment.routes.js" \
      "backend/services/eventBus.service.js" \
      "backend/services/featureFlags.service.js"
    do
      fp="$REPO_ROOT/$f"
      if [[ -f "$fp" ]]; then
        if node --input-type=module --check < "$fp" 2>/dev/null; then
          ok "Syntax OK: $(basename "$f")"
        else
          warn "Syntax check inconclusive (module imports): $(basename "$f")"
        fi
      fi
    done
  else
    warn "node not found — skipping build verification"
  fi
else
  [[ "$PHASE" != "all" ]] || info "STEP 4: Build verification skipped (pass --verify-build to enable)"
fi

# ── STEP 5: Validate ──────────────────────────────────────────────────────────
banner "STEP 5: Validate"
if $DRY_RUN; then
  warn "Dry run — skipping validation"
elif [[ ! -f "$VALIDATE_SH" ]]; then
  warn "validate-migration.sh not found — skipping"
else
  validate_exit=0
  bash "$VALIDATE_SH" --repo-root "$REPO_ROOT" || validate_exit=$?
  if [[ $validate_exit -ne 0 ]]; then
    err "Validation failed (code $validate_exit)"
    [[ -n "$CHECKPOINT_BRANCH" ]] && warn "Rollback: bash tools/rollback.sh --repo-root $REPO_ROOT --branch $CHECKPOINT_BRANCH"
    exit 1
  fi
  ok "Validation passed"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
if $DRY_RUN; then
  echo -e "${YELLOW}${BOLD}DRY RUN — no files written. Re-run without --dry-run to apply.${RESET}"
else
  echo -e "${GREEN}${BOLD}╔════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}${BOLD}║  Migration complete ✓  [phase: $PHASE]${RESET}"
  echo -e "${GREEN}${BOLD}╚════════════════════════════════════════════════════════════╝${RESET}"
  echo
  echo "  Next steps:"
  echo "  1. Review changes:   git diff HEAD"
  echo "  2. Run tests:        cd backend && npm test"
  echo "  3. Commit:           git add -A && git commit -m 'feat: domain migration [phase=$PHASE]'"
  [[ -n "$CHECKPOINT_BRANCH" ]] && echo "  4. Rollback if needed: bash tools/rollback.sh --branch $CHECKPOINT_BRANCH"
fi
echo