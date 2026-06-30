#!/usr/bin/env bash
# ============================================================
# fix-wsservice.sh
# TWO BUGS FIXED:
#
# BUG 1 — ReferenceError: wsService is not defined
#   Cause:  During the WS→SSE migration, wsService was stripped
#           from imports/files but call-sites were not updated.
#           8 files still call wsService.on/off/connect/disconnect
#           with no import, causing a fatal ReferenceError that
#           crashes the React tree → blank white panel.
#
#   Fix:    Replace every wsService.* call with sseService.*
#           and add the missing import where absent.
#           Private admin/merchant events are passed through the
#           existing SSEService.on/off API — the SSE service
#           already supports arbitrary event names via .on().
#
# BUG 2 — Admin + Merchant panel look "bland white and black"
#   Cause:  The merchant panel's tailwind.config.js is missing
#           the dark/gold color palette that the components use.
#           Without those custom colours, Tailwind generates
#           fallback (white/gray) styles → no dark theme.
#
#   Fix:    Add the full dark/gold palette to merchant tailwind
#           config, matching admin-panel exactly.
# ============================================================
set -e

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
ADMIN="$ROOT/admin-panel/src"
MERCHANT="$ROOT/merchant-panel/src"

echo "🔧 Fixing wsService → sseService in admin-panel..."

# ── admin-panel/src/App.tsx ─────────────────────────────────
# Already imports sseService. Just replace wsService calls.
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g;
   s/wsService\.connect()/sseService.connect()/g;
   s/wsService\.disconnect()/sseService.disconnect()/g' \
  "$ADMIN/App.tsx"

echo "  ✅ admin-panel/src/App.tsx"

# ── admin-panel/src/Pages/Merchants/MerchantsList.tsx ───────
# No sseService import yet — add it, then replace calls.
if ! grep -q "import sseService" "$ADMIN/Pages/Merchants/MerchantsList.tsx"; then
  sed -i "1s|^|import sseService from '../../services/sse';\n|" \
    "$ADMIN/Pages/Merchants/MerchantsList.tsx"
fi
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$ADMIN/Pages/Merchants/MerchantsList.tsx"

echo "  ✅ admin-panel/src/Pages/Merchants/MerchantsList.tsx"

# ── admin-panel/src/Pages/QueueManager/QueueDashboard.tsx ───
if ! grep -q "import sseService" "$ADMIN/Pages/QueueManager/QueueDashboard.tsx"; then
  sed -i "1s|^|import sseService from '../../services/sse';\n|" \
    "$ADMIN/Pages/QueueManager/QueueDashboard.tsx"
fi
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$ADMIN/Pages/QueueManager/QueueDashboard.tsx"

echo "  ✅ admin-panel/src/Pages/QueueManager/QueueDashboard.tsx"

# ── admin-panel/src/Pages/Cycles/LiveCycles.tsx ─────────────
# Already imports sseService — just fix the wsService calls.
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$ADMIN/Pages/Cycles/LiveCycles.tsx"

echo "  ✅ admin-panel/src/Pages/Cycles/LiveCycles.tsx"

# ── admin-panel/src/Pages/KYC/KYCQueue.tsx ──────────────────
if ! grep -q "import sseService" "$ADMIN/Pages/KYC/KYCQueue.tsx"; then
  sed -i "1s|^|import sseService from '../../services/sse';\n|" \
    "$ADMIN/Pages/KYC/KYCQueue.tsx"
fi
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$ADMIN/Pages/KYC/KYCQueue.tsx"

echo "  ✅ admin-panel/src/Pages/KYC/KYCQueue.tsx"

echo ""
echo "🔧 Fixing wsService → sseService in merchant-panel..."

# ── merchant-panel/src/App.tsx ───────────────────────────────
# Already imports sseService. Replace wsService calls.
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g;
   s/wsService\.connect()/sseService.connect()/g;
   s/wsService\.disconnect()/sseService.disconnect()/g' \
  "$MERCHANT/App.tsx"

echo "  ✅ merchant-panel/src/App.tsx"

# ── merchant-panel/src/pages/Dashboard.tsx ──────────────────
if ! grep -q "import sseService" "$MERCHANT/pages/Dashboard.tsx"; then
  sed -i "1s|^|import sseService from '../services/sse';\n|" \
    "$MERCHANT/pages/Dashboard.tsx"
fi
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$MERCHANT/pages/Dashboard.tsx"

echo "  ✅ merchant-panel/src/pages/Dashboard.tsx"

# ── merchant-panel/src/pages/OrderManagement.tsx ────────────
if ! grep -q "import sseService" "$MERCHANT/pages/OrderManagement.tsx"; then
  sed -i "1s|^|import sseService from '../services/sse';\n|" \
    "$MERCHANT/pages/OrderManagement.tsx"
fi
sed -i \
  's/wsService\.on(/sseService.on(/g;
   s/wsService\.off(/sseService.off(/g' \
  "$MERCHANT/pages/OrderManagement.tsx"

echo "  ✅ merchant-panel/src/pages/OrderManagement.tsx"

# ── VERIFY: no wsService references remain ──────────────────
echo ""
echo "🔍 Verifying — remaining wsService calls (should be zero):"
REMAINING=$(grep -rn "wsService" \
  "$ROOT/admin-panel/src" \
  "$ROOT/merchant-panel/src" 2>/dev/null | wc -l)
if [ "$REMAINING" -eq 0 ]; then
  echo "  ✅ Zero wsService references remaining"
else
  echo "  ⚠️  $REMAINING references still found:"
  grep -rn "wsService" "$ROOT/admin-panel/src" "$ROOT/merchant-panel/src" 2>/dev/null
fi

# ──────────────────────────────────────────────────────────────────────────────
# BUG 2 — Merchant panel missing dark/gold Tailwind palette
# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo "🎨 Fixing merchant-panel tailwind.config.js (missing dark/gold palette)..."

cat > "$ROOT/merchant-panel/tailwind.config.js" << 'TAILWIND'
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ✅ Required so @apply border-border works (prevents blank-screen bug)
        border: '#334155',
        primary: {
          50:  '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        gold: {
          400: '#F5C77A',
          500: '#D4AF37',
          600: '#B8941F',
        },
        dark: {
          900: '#0B0E14',
          800: '#121826',
          700: '#1E293B',
          600: '#334155',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
TAILWIND

echo "  ✅ merchant-panel/tailwind.config.js updated"

# ── Also fix merchant panel index.css to apply dark body bg ─
# The merchant panel CSS sets no background — components use bg-gray-100 (white).
# Ensure the CSS sets the dark body bg so it matches admin.
MERCHANT_CSS="$ROOT/merchant-panel/src/index.css"
if ! grep -q "bg-dark-900\|#0B0E14\|dark background" "$MERCHANT_CSS"; then
  cat >> "$MERCHANT_CSS" << 'BODY_CSS'

/* Dark theme base — aligns merchant panel with admin panel */
body {
  background-color: #0B0E14;
  color: #F3F4F6;
}
BODY_CSS
  echo "  ✅ merchant-panel/src/index.css — dark body background added"
else
  echo "  ℹ️  merchant-panel/src/index.css already has dark background"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ All fixes applied. Commit and push to redeploy:"
echo ""
echo "  git add -A"
echo "  git commit -m 'fix: replace wsService with sseService (ReferenceError); restore dark theme in merchant panel'"
echo "  git push"
echo "════════════════════════════════════════════════════════"