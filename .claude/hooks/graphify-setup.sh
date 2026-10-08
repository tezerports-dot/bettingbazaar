#!/usr/bin/env bash
# GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
# SessionStart hook: install the graphify CLI if missing, then build or refresh
# the code graph in graphify-out/. Code-only (local AST, no API key, nothing
# leaves the machine). Never fails the session: every failure exits 0.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0
export PATH="$HOME/.local/bin:$PATH"

if ! command -v graphify >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv tool install "graphifyy[sql,mcp]" >/dev/null 2>&1
  elif command -v pipx >/dev/null 2>&1; then
    pipx install "graphifyy[sql,mcp]" >/dev/null 2>&1
  fi
fi
command -v graphify >/dev/null 2>&1 || { echo "graphify not installed; skipping the code graph" >&2; exit 0; }

if [ -f graphify-out/graph.json ]; then
  graphify update . >/dev/null 2>&1
else
  graphify extract . --code-only >/dev/null 2>&1 \
    && graphify cluster-only . --no-label --no-viz >/dev/null 2>&1
fi
exit 0
