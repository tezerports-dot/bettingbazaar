#!/usr/bin/env bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fix4-files"
cp "$DIR/OrderManagement.tsx" "$REPO/merchant-panel/src/pages/OrderManagement.tsx"
echo "[OK] OrderManagement.tsx fixed"
echo ""
echo "Commit:"
echo "  git add -A && git commit -m 'fix: restore missing lucide-react icon imports (Clock, CheckCircle, AlertCircle) in OrderManagement.tsx — was causing blank white Orders page (Vite build failure)'"
