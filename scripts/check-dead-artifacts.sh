#!/bin/bash
# check-dead-artifacts.sh — GOVERNANCE sec.13: Dead Artifact Policy enforcer
# Run as pre-commit hook: cp scripts/check-dead-artifacts.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Fails if any forbidden artifact patterns are found in the staged/working tree.

set -e
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "🔍 GOVERNANCE sec.13: Checking for dead artifacts..."

# 1. Patch files in repo root
if ls *.patch 2>/dev/null | grep -q .; then
  echo -e "${RED}FAIL: .patch files found in repo root. Apply and delete before commit.${NC}"
  ls *.patch
  ERRORS=$((ERRORS + 1))
fi

# 2. apply-changes.sh or similar fix scripts
for f in apply-changes.sh apply-fix.sh apply-patch.sh fix-all.sh; do
  if [ -f "$f" ]; then
    echo -e "${RED}FAIL: $f found. Apply and delete before commit (GOVERNANCE sec.13).${NC}"
    ERRORS=$((ERRORS + 1))
  fi
done

# 3. Migration files without APPLIED or PENDING marker
for f in backend/migrations/*.js backend/scripts/migrate-*.js; do
  [ -f "$f" ] || continue
  if ! grep -q "MIGRATION STATUS:" "$f" 2>/dev/null; then
    echo -e "${YELLOW}WARN: $f has no MIGRATION STATUS comment. Add one (GOVERNANCE sec.13).${NC}"
  fi
done

# 4. Version literals in component source files
while IFS= read -r file; do
  if grep -nP "version:\s*['\"][0-9]+\.[0-9]+\.[0-9]+['\"]" "$file" 2>/dev/null | grep -v "VITE_APP_VERSION\|node_modules\|package.json" | grep -q .; then
    echo -e "${YELLOW}WARN: version literal found in $file (use VITE_APP_VERSION instead — GOVERNANCE sec.8)${NC}"
  fi
done < <(find . -name "*.tsx" -o -name "*.ts" | grep -v node_modules | grep -v dist)

# 5. Files missing GOVERNANCE header
MISSING=0
while IFS= read -r file; do
  if ! head -10 "$file" | grep -q "GOVERNANCE: Read docs/governance/04-GOVERNANCE.md"; then
    MISSING=$((MISSING + 1))
  fi
done < <(find . \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  | grep -v node_modules | grep -v dist | grep -v ".eslintrc" \
  | grep -v "vite.config" | grep -v "tailwind.config" | grep -v "postcss.config" \
  | head -50)

if [ $MISSING -gt 0 ]; then
  echo -e "${YELLOW}WARN: $MISSING source files are missing GOVERNANCE header (GOVERNANCE sec.15). Run scripts/add-governance-headers.sh${NC}"
fi

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ Dead artifact check FAILED ($ERRORS errors). Fix before committing.${NC}"
  exit 1
else
  echo -e "${GREEN}✅ Dead artifact check passed.${NC}"
fi
