#!/usr/bin/env bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fix3v2-files"
cp "$DIR/merchantScoring.service.js" "$REPO/backend/services/merchantScoring.service.js"
cp "$DIR/OrderManagement.tsx"        "$REPO/merchant-panel/src/pages/OrderManagement.tsx"
echo "[OK] 2 files applied"
echo ""
echo "Commit:"
echo "  git add -A && git commit -m 'fix: remove status:ACTIVE gate from merchant scoring (auto-assign now works), replace blank white screen with clean order detail panel (no chat)'"
