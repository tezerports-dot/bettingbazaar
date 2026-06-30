#!/usr/bin/env bash
# validate-migration.sh — Betting Bazaar migration validator
#
# Usage:
#   bash tools/validate-migration.sh [--repo-root PATH] [--json]
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -uo pipefail

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; BOLD='\033[1m'; RESET='\033[0m'

pass()  { echo -e "  ${GREEN}[PASS]${RESET}  $*"; ((PASS_COUNT++));  }
fail()  { echo -e "  ${RED}[FAIL]${RESET}  $*"; ((FAIL_COUNT++));   }
skip()  { echo -e "  ${CYAN}[SKIP]${RESET}  $*"; ((SKIP_COUNT++));  }
warn()  { echo -e "  ${YELLOW}[WARN]${RESET}  $*"; ((WARN_COUNT++)); }
group() { echo -e "\n${BOLD}$*${RESET}"; }

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0; WARN_COUNT=0
JSON_OUT=false
REPO_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root=*) REPO_ROOT="${1#--repo-root=}"; shift ;;
    --repo-root)   REPO_ROOT="$2"; shift 2 ;;
    --json)        JSON_OUT=true; shift ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

# Auto-detect repo root
if [[ -z "$REPO_ROOT" ]]; then
  candidate="$(pwd)"
  for _ in 1 2 3 4 5; do
    if [[ -d "$candidate/backend" && -f "$candidate/package.json" ]]; then
      REPO_ROOT="$candidate"; break
    fi
    candidate="$(dirname "$candidate")"
  done
fi
[[ -z "$REPO_ROOT" || ! -d "$REPO_ROOT" ]] && { echo "Cannot locate repo root. Use --repo-root=PATH" >&2; exit 1; }
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

echo -e "${BOLD}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Betting Bazaar — Migration Validator                      ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════╝${RESET}"
echo "  Repository: $REPO_ROOT"
echo

# ─── Helpers ──────────────────────────────────────────────────────────────────
file_exists()    { [[ -f "$REPO_ROOT/$1" ]]; }
dir_exists()     { [[ -d "$REPO_ROOT/$1" ]]; }
file_absent()    { [[ ! -f "$REPO_ROOT/$1" ]]; }
contains()       { local f="$REPO_ROOT/$1"; [[ -f "$f" ]] && grep -qF "$2" "$f"; }
not_contains()   { local f="$REPO_ROOT/$1"; [[ ! -f "$f" ]] || ! grep -qF "$2" "$f"; }
count_pattern()  {
  local dir="$REPO_ROOT" pattern="$1"
  grep -rl --include="*.js" --include="*.ts" --include="*.tsx" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude-dir=tools --exclude="*.bak" \
    -E "$pattern" "$dir" 2>/dev/null || true
}


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 1 — P2P elimination
# ═══════════════════════════════════════════════════════════════════════════════
group "1 / P2P Elimination"

# Legacy model must be gone
if file_absent "backend/models/p2pOrder.model.js"; then
  pass "p2pOrder.model.js deleted"
else
  fail "p2pOrder.model.js still exists — run: python3 tools/domain_migration.py --phase patches"
fi

# Legacy route file must be gone
if file_absent "backend/routes/p2p.routes.js"; then
  pass "p2p.routes.js deleted"
else
  fail "p2p.routes.js still exists — run: python3 tools/domain_migration.py --phase core"
fi

# Legacy chat model must be gone
if file_absent "backend/models/chat.model.js"; then
  pass "chat.model.js deleted"
else
  fail "chat.model.js still exists"
fi

# Legacy P2P state machine must be gone
if file_absent "services/p2pStateMachine.ts"; then
  pass "p2pStateMachine.ts deleted"
else
  fail "p2pStateMachine.ts still exists"
fi

# New payment order model must exist
if file_exists "backend/models/paymentOrder.model.js"; then
  pass "paymentOrder.model.js exists"
else
  fail "paymentOrder.model.js missing — run migration (core phase)"
fi

# paymentOrder.model.js must not export P2POrder alias
if not_contains "backend/models/paymentOrder.model.js" "export const P2POrder"; then
  pass "paymentOrder.model.js — no P2POrder alias"
else
  fail "paymentOrder.model.js still exports P2POrder alias — run: --phase patches"
fi

# server.js must import payment routes, not p2p routes
if contains "backend/server.js" "paymentRoutes"; then
  pass "server.js uses paymentRoutes"
else
  fail "server.js still uses p2pRoutes — run: --phase core"
fi

# Validation schema must use paymentOrder, not p2pOrder
if not_contains "backend/middleware/validation.js" "p2pOrder:"; then
  pass "validation.js — Zod schema uses paymentOrder"
else
  fail "validation.js still has p2pOrder: Zod key — run: --phase patches"
fi

# WalletPage must not use 'p2p' tab key
if not_contains "pages/WalletPage.tsx" "tab === 'p2p'"; then
  pass "WalletPage.tsx — no 'p2p' tab key"
else
  fail "WalletPage.tsx still uses tab === 'p2p' — run: --phase patches"
fi

# paymentStateMachine must not re-export P2P aliases
if not_contains "services/paymentStateMachine.ts" "export const P2P_STATES"; then
  pass "paymentStateMachine.ts — no P2P alias exports"
else
  fail "paymentStateMachine.ts still has P2P alias exports — run: --phase patches"
fi


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 2 — Runtime P2P reference sweep
# ═══════════════════════════════════════════════════════════════════════════════
group "2 / Runtime P2P Reference Sweep"

P2P_MODEL_REFS=$(count_pattern "mongoose\.model\(['\"]P2POrder['\"]|new P2POrder\(" | wc -l | tr -d ' ')
if [[ "$P2P_MODEL_REFS" -eq 0 ]]; then
  pass "No mongoose.model('P2POrder') or new P2POrder() references"
else
  fail "$P2P_MODEL_REFS file(s) still reference mongoose.model('P2POrder') or new P2POrder()"
  count_pattern "mongoose\.model\(['\"]P2POrder['\"]|new P2POrder\(" | while read -r f; do
    echo "     → ${f#$REPO_ROOT/}"
  done
fi

P2P_API_REFS=$(count_pattern "/api/p2p/" | grep -v "node_modules" | wc -l | tr -d ' ')
if [[ "$P2P_API_REFS" -eq 0 ]]; then
  pass "No /api/p2p/ URL references in source"
else
  fail "$P2P_API_REFS file(s) still reference /api/p2p/ — clients must use /api/payment/"
  count_pattern "/api/p2p/" | while read -r f; do
    echo "     → ${f#$REPO_ROOT/}"
  done
fi

P2P_IMPORT_REFS=$(count_pattern "p2pStateMachine|p2p\.routes|chat\.model" | wc -l | tr -d ' ')
if [[ "$P2P_IMPORT_REFS" -eq 0 ]]; then
  pass "No imports of p2pStateMachine / p2p.routes / chat.model"
else
  fail "$P2P_IMPORT_REFS file(s) import deleted P2P modules"
  count_pattern "p2pStateMachine|p2p\.routes|chat\.model" | while read -r f; do
    echo "     → ${f#$REPO_ROOT/}"
  done
fi


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 3 — New architecture files
# ═══════════════════════════════════════════════════════════════════════════════
group "3 / Payment Architecture"

for f in \
  "backend/routes/payment.routes.js" \
  "backend/services/paymentProcessing.service.js" \
  "services/paymentStateMachine.ts"
do
  if file_exists "$f"; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

# Confirm PaymentOrder model is registered
if contains "backend/models/index.js" "paymentOrder.model.js"; then
  pass "models/index.js exports paymentOrder.model.js"
else
  fail "models/index.js does not export paymentOrder.model.js"
fi

# Confirm payment route is mounted
if contains "backend/server.js" "/api/payment"; then
  pass "server.js mounts /api/payment"
else
  fail "server.js does not mount /api/payment"
fi


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 4 — Architecture extension points
# ═══════════════════════════════════════════════════════════════════════════════
group "4 / Architecture Extension Points"

ARCH_FILES=(
  "backend/providers/payment/PaymentProvider.interface.js"
  "backend/providers/casino/CasinoProvider.interface.js"
  "backend/providers/sportsbook/SportsbookProvider.interface.js"
  "backend/providers/registry.js"
  "backend/services/eventBus.service.js"
  "backend/services/featureFlags.service.js"
  "services/sseEvents.types.ts"
)
for f in "${ARCH_FILES[@]}"; do
  if file_exists "$f"; then
    pass "$f"
  else
    fail "$f missing — run: python3 tools/domain_migration.py --phase architecture"
  fi
done

# Spot-check eventBus exports EVENTS catalog
if contains "backend/services/eventBus.service.js" "export const EVENTS"; then
  pass "eventBus.service.js exports EVENTS catalog"
else
  fail "eventBus.service.js missing EVENTS catalog"
fi

# Spot-check featureFlags exports FLAGS
if contains "backend/services/featureFlags.service.js" "export const FLAGS"; then
  pass "featureFlags.service.js exports FLAGS"
else
  fail "featureFlags.service.js missing FLAGS export"
fi

# Spot-check SSE types export SSE_EVENTS
if contains "services/sseEvents.types.ts" "export const SSE_EVENTS"; then
  pass "sseEvents.types.ts exports SSE_EVENTS"
else
  fail "sseEvents.types.ts missing SSE_EVENTS"
fi


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 5 — Cleanliness
# ═══════════════════════════════════════════════════════════════════════════════
group "5 / Cleanliness"

# No .bak files
BAK_COUNT=$(find "$REPO_ROOT" -name "*.bak" \
  ! -path "*/node_modules/*" ! -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$BAK_COUNT" -eq 0 ]]; then
  pass "No .bak files"
else
  fail "$BAK_COUNT .bak file(s) remain — run: python3 tools/domain_migration.py --phase cleanup"
  find "$REPO_ROOT" -name "*.bak" \
    ! -path "*/node_modules/*" ! -path "*/.git/*" 2>/dev/null \
    | head -10 | while read -r f; do echo "     → ${f#$REPO_ROOT/}"; done
fi

# Governance headers on core new files
for f in \
  "backend/models/paymentOrder.model.js" \
  "backend/routes/payment.routes.js" \
  "backend/services/paymentProcessing.service.js" \
  "backend/services/eventBus.service.js" \
  "backend/services/featureFlags.service.js"
do
  if file_exists "$f"; then
    if contains "$f" "GOVERNANCE"; then
      pass "Governance header: $f"
    else
      warn "Missing governance header: $f"
    fi
  fi
done

# No TODOs in migration-critical files
TODO_COUNT=$(grep -rl --include="*.js" --include="*.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude="*.bak" \
  "TODO.*[Pp]2[Pp]\|FIXME.*[Pp]2[Pp]\|HACK.*[Pp]2[Pp]" "$REPO_ROOT" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$TODO_COUNT" -eq 0 ]]; then
  pass "No P2P-related TODO/FIXME/HACK comments"
else
  warn "$TODO_COUNT file(s) have P2P-related TODO/FIXME comments"
fi

# No duplicate PaymentOrder model registration
DUP_MODEL=$(grep -rl --include="*.js" --exclude-dir=node_modules --exclude-dir=.git \
  "mongoose.model('PaymentOrder'" "$REPO_ROOT/backend" 2>/dev/null \
  | grep -v "paymentOrder.model.js" | wc -l | tr -d ' ')
if [[ "$DUP_MODEL" -eq 0 ]]; then
  pass "PaymentOrder model registered in one place only"
else
  warn "$DUP_MODEL other file(s) call mongoose.model('PaymentOrder') outside the model file"
fi


# ═══════════════════════════════════════════════════════════════════════════════
# CHECK GROUP 6 — Migration state
# ═══════════════════════════════════════════════════════════════════════════════
group "6 / Migration State"

STATE_FILE="$REPO_ROOT/tools/.migration-state.json"
if [[ -f "$STATE_FILE" ]]; then
  COMPLETED=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(len(d.get('completed',[])))" 2>/dev/null || echo "?")
  FAILED=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(len(d.get('failed',{})))" 2>/dev/null || echo "?")
  LAST=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('last_run','never'))" 2>/dev/null || echo "?")
  pass "State file exists: $COMPLETED steps completed, $FAILED failed (last run: $LAST)"
  if [[ "$FAILED" != "0" && "$FAILED" != "?" ]]; then
    warn "$FAILED step(s) marked as failed in state file — re-run with --force"
  fi
else
  skip "State file not found (migration not yet run)"
fi

# Migration report
if file_exists "tools/migration-report.json"; then
  pass "Migration report exists: tools/migration-report.json"
else
  skip "Migration report not yet generated — run: --phase report"
fi


# ═══════════════════════════════════════════════════════════════════════════════
# FINAL RESULT
# ═══════════════════════════════════════════════════════════════════════════════
echo
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  PASS: ${GREEN}${BOLD}$PASS_COUNT${RESET}   FAIL: ${RED}${BOLD}$FAIL_COUNT${RESET}   WARN: ${YELLOW}${BOLD}$WARN_COUNT${RESET}   SKIP: ${CYAN}${BOLD}$SKIP_COUNT${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}All checks passed — migration verified ✓${RESET}\n"
  RESULT=0
else
  echo -e "\n  ${RED}${BOLD}$FAIL_COUNT check(s) failed — see above.${RESET}"
  echo
  echo "  To fix, run the appropriate phase:"
  echo "    python3 tools/domain_migration.py --phase core          # P2P→Payment model/route/type migration"
  echo "    python3 tools/domain_migration.py --phase patches       # Remaining P2P refs"
  echo "    python3 tools/domain_migration.py --phase architecture  # Provider interfaces, event bus, flags"
  echo "    python3 tools/domain_migration.py --phase cleanup       # Remove .bak files"
  echo "    python3 tools/domain_migration.py --phase all           # Everything"
  echo
  RESULT=1
fi

# ── Optional JSON output ───────────────────────────────────────────────────────
if $JSON_OUT; then
  REPORT="$REPO_ROOT/tools/validation-report.json"
  cat > "$REPORT" << JSONEOF
{
  "generated_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "repo_root":    "$REPO_ROOT",
  "result":       $([ $RESULT -eq 0 ] && echo '"pass"' || echo '"fail"'),
  "pass_count":   $PASS_COUNT,
  "fail_count":   $FAIL_COUNT,
  "warn_count":   $WARN_COUNT,
  "skip_count":   $SKIP_COUNT
}
JSONEOF
  echo "  JSON report: $REPORT"
fi

exit $RESULT 