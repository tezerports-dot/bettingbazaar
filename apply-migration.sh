#!/usr/bin/env bash
# apply-migration.sh
# Applies the complete payment system migration to betting-bazaar.
# Run from repo root: bash apply-migration.sh
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "[apply] Repo root: $REPO_ROOT"

apply_file() {
  local src="$1"
  local dst="$REPO_ROOT/$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  [OK] $2"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$SCRIPT_DIR/migration-files"

# Verify patch dir exists
if [ ! -d "$PATCH_DIR" ]; then
  echo "[ERROR] migration-files/ directory not found next to apply-migration.sh"
  echo "  Expected: $PATCH_DIR"
  exit 1
fi

echo ""
echo "=== Applying 21 changed files ==="
apply_file "$PATCH_DIR/merchant.model.js"                  "backend/models/merchant.model.js"
apply_file "$PATCH_DIR/paymentOrder.model.js"              "backend/models/paymentOrder.model.js"
apply_file "$PATCH_DIR/merchantScoring.service.js"         "backend/services/merchantScoring.service.js"
apply_file "$PATCH_DIR/paymentProcessing.service.js"       "backend/services/paymentProcessing.service.js"
apply_file "$PATCH_DIR/realtimeEmitters.js"                "backend/services/realtimeEmitters.js"
apply_file "$PATCH_DIR/payment.routes.js"                  "backend/routes/payment.routes.js"
apply_file "$PATCH_DIR/merchant.routes.js"                 "backend/routes/merchant.routes.js"
apply_file "$PATCH_DIR/queue.admin.routes.js"              "backend/routes/admin/queue.admin.routes.js"
apply_file "$PATCH_DIR/upload.routes.js"                   "backend/routes/upload.routes.js"
apply_file "$PATCH_DIR/WalletPage.tsx"                     "pages/WalletPage.tsx"
apply_file "$PATCH_DIR/CountdownTimer.tsx"                 "merchant-panel/src/components/CountdownTimer.tsx"
apply_file "$PATCH_DIR/OrderCard.tsx"                      "merchant-panel/src/components/OrderCard.tsx"
apply_file "$PATCH_DIR/OrderManagement.tsx"                "merchant-panel/src/pages/OrderManagement.tsx"
apply_file "$PATCH_DIR/ProfileSettings.tsx"                "merchant-panel/src/pages/ProfileSettings.tsx"
apply_file "$PATCH_DIR/Dashboard.tsx"                      "merchant-panel/src/pages/Dashboard.tsx"
apply_file "$PATCH_DIR/App.tsx"                            "merchant-panel/src/App.tsx"
apply_file "$PATCH_DIR/Layout.tsx"                         "merchant-panel/src/components/Layout.tsx"
apply_file "$PATCH_DIR/PaymentControlCenter.tsx"           "admin-panel/src/Pages/Payment/PaymentControlCenter.tsx"
apply_file "$PATCH_DIR/MerchantsList.tsx"                  "admin-panel/src/Pages/Merchants/MerchantsList.tsx"
apply_file "$PATCH_DIR/api.ts"                             "merchant-panel/src/services/api.ts"
apply_file "$PATCH_DIR/types.ts"                           "merchant-panel/src/types.ts"

echo ""
echo "=== All 21 files applied ==="
echo ""
echo "Commit with:"
echo "  git add -A && git commit -m 'feat: complete payment system migration — instant UPI merchant matching, escrow locks, 15-min timer, dynamic QR, auto-complete withdrawals, dispute flow, merchant scoring algorithm, remove queue manager and bulk payouts'"
