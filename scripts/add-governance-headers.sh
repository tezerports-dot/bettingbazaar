#!/bin/bash
# add-governance-headers.sh — Adds GOVERNANCE header to any source file missing one.
# GOVERNANCE sec.15: every file must reference 04-GOVERNANCE.md in first 10 lines.
# Run: bash scripts/add-governance-headers.sh

HEADER='// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)'
ADDED=0
SKIPPED=0

while IFS= read -r file; do
  if head -10 "$file" | grep -q "GOVERNANCE: Read 04-GOVERNANCE.md"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  # Prepend header to file
  tmpfile=$(mktemp)
  echo "$HEADER" > "$tmpfile"
  cat "$file" >> "$tmpfile"
  mv "$tmpfile" "$file"
  ADDED=$((ADDED + 1))
  echo "  Tagged: $file"
done < <(find . \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  | grep -v node_modules | grep -v dist | grep -v ".eslintrc" \
  | grep -v "vite.config" | grep -v "tailwind.config")

echo "Done: $ADDED files tagged, $SKIPPED already had header."
