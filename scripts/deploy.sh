#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Betting Bazaar Production Deploy Script
# =============================================================================
# Execution order:
#   1. Run full-validation.sh (abort if any FAIL)
#   2. git add -A
#   3. git commit -m "production audit fixes"
#   4. git push
#   5. railway up
#
# Prerequisites:
#   - mega-fix.sh has been run and succeeded
#   - full-validation.sh passes with 0 failures
#   - railway CLI installed and authenticated (railway login)
#   - git remote configured
#   - No uncommitted changes from non-audit sources
#
# DO NOT RUN without approval from MASTER_AUDIT.md review.
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG="$PROJECT_ROOT/.deploy-log-$(date +%Y%m%d_%H%M%S).txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()    { echo "[$(date +%H:%M:%S)] $*" | tee -a "$DEPLOY_LOG"; }
section(){ echo -e "\n${BLUE}━━━ $1 ━━━${NC}" | tee -a "$DEPLOY_LOG"; }
abort()  { echo -e "${RED}DEPLOY ABORTED: $1${NC}" | tee -a "$DEPLOY_LOG"; exit 1; }

cd "$PROJECT_ROOT"
log "Deploy started from: $PROJECT_ROOT"
log "Log: $DEPLOY_LOG"

# =============================================================================
# STEP 0 — PRE-DEPLOY GUARDS
# =============================================================================
section "STEP 0: PRE-DEPLOY GUARDS"

# Guard: mega-fix.sh must have run (check for at least one fix marker)
if ! grep -qr "HIGH-06 FIX\|CRIT-05\|HIGH-03: atomicBet removed" backend/ 2>/dev/null; then
  abort "Audit fixes do not appear to be applied. Run scripts/mega-fix.sh first."
fi
log "Fix markers detected — mega-fix.sh appears to have run"

# Guard: orphan file must be deleted
if [[ -f "backend/routes/admin.routes.js" ]]; then
  abort "backend/routes/admin.routes.js still exists — CRIT-04 not applied. Run mega-fix.sh."
fi
log "CRIT-04: orphan file confirmed deleted"

# Guard: git must be initialized
git rev-parse --is-inside-work-tree > /dev/null 2>&1 || abort "Not inside a git repository"
log "Git repository confirmed"

# Guard: railway CLI must be available
command -v railway > /dev/null 2>&1 || abort "railway CLI not found. Install: npm install -g @railway/cli && railway login"
log "Railway CLI found: $(railway --version 2>/dev/null || echo 'version unknown')"

# =============================================================================
# STEP 1 — RUN FULL VALIDATION
# =============================================================================
section "STEP 1: FULL VALIDATION"

log "Running full-validation.sh..."
if bash "$PROJECT_ROOT/scripts/full-validation.sh" 2>&1 | tee -a "$DEPLOY_LOG"; then
  log "Validation PASSED"
else
  VALIDATION_EXIT=$?
  abort "Validation FAILED (exit $VALIDATION_EXIT). Fix all failing checks before deploying."
fi

# =============================================================================
# STEP 2 — GIT ADD
# =============================================================================
section "STEP 2: GIT ADD"

log "Staging all changes..."
git add -A
log "Staged files:"
git diff --cached --name-only | tee -a "$DEPLOY_LOG"

# Confirm there is something to commit
if git diff --cached --quiet; then
  log "No changes staged — nothing to commit (fixes may already be committed)"
else
  log "Changes staged successfully"
fi

# =============================================================================
# STEP 3 — GIT COMMIT
# =============================================================================
section "STEP 3: GIT COMMIT"

COMMIT_MSG="production audit fixes

Issues resolved (MASTER_AUDIT.md + AUDIT_VALIDATION.md):
- CRIT-01: P2P withdrawal debit ordering fixed (fund loss prevention)
- CRIT-02: Merchant confirm tokenBalance tracking added
- CRIT-03: Bet refund WalletLedger CREDIT entry added
- CRIT-04: Orphaned admin.routes.js deleted (3677 lines, 94 dead routes)
- CRIT-05: Admin login Express stack splice replaced with named export
- HIGH-01: authenticateMerchant fixed to use Merchant model
- HIGH-02: Merchant tokenBalance maintained in P2P lifecycle
- HIGH-03: Dead atomicBet import removed from bet.routes.js
- HIGH-04: Duplicate GET /token-rates route removed from cycles.admin
- HIGH-05: JWT_EXPIRES env var standardised to JWT_EXPIRES_IN
- HIGH-06: isAccountLocked check added to authenticate middleware
- HIGH-08: P2P system message silent catches replaced with logging
- HIGH-09: Non-existent User fields removed from seedAdmin.js
- HIGH-10: Merchant confirm creditDeposit fires before status=COMPLETED
- MED-01: Bet ledger txId uses randomUUID (no Date.now collision risk)
- MED-02: Admin panel login uses /api/admin/login (adminAuthLimiter)
- MED-03: WalletPage/WalletModal silent catches now log errors
- MED-04: Duplicate /api/auth route mount removed
- MED-05: Token rates fallback now warns + sets ratesConfigured flag
- MED-06: Admin GET /token-rates response shape normalised to {rates:{}}
- MED-08: KYC approve/reject write EnhancedAuditLog entries
- LOW-02: Admin session JSON parse catch blocks now log warnings
- LOW-03: seedAdmin conditional re-hash (skips if credentials unchanged)
- LOW-04: GameProviderContext silent catch replaced with console.warn
- LOW-05: Admin-created merchants auto-approved (no manual step needed)
- LOW-06: FrontendErrorReport model location documented in server.js"

if git diff --cached --quiet; then
  log "Nothing to commit — skipping commit step"
else
  git commit -m "$COMMIT_MSG"
  log "Committed: $(git rev-parse HEAD)"
fi

# =============================================================================
# STEP 4 — GIT PUSH
# =============================================================================
section "STEP 4: GIT PUSH"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "Pushing branch: $BRANCH"

git push origin "$BRANCH" 2>&1 | tee -a "$DEPLOY_LOG" || abort "git push failed"
log "Push successful"

# =============================================================================
# STEP 5 — RAILWAY DEPLOY
# =============================================================================
section "STEP 5: RAILWAY DEPLOY"

log "Starting Railway deployment..."
railway up 2>&1 | tee -a "$DEPLOY_LOG" || abort "railway up failed"

log "Railway deployment initiated"

# =============================================================================
# DEPLOY COMPLETE
# =============================================================================
section "DEPLOY COMPLETE"

echo -e "${GREEN}✅ Deployment pipeline completed successfully${NC}"
log "Deploy log: $DEPLOY_LOG"
echo ""
echo "Post-deploy verification steps:"
echo "  1. Wait ~2 min for Railway to spin up new containers"
echo "  2. BASE_URL=https://your-backend.railway.app bash scripts/full-validation.sh"
echo "  3. Manually test: admin login, P2P deposit, P2P withdrawal, phantom bet"
echo "  4. Check Railway logs: railway logs --tail"
