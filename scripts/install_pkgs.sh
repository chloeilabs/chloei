#!/bin/bash
# Bootstrap dependencies for a fresh Claude Code cloud session.
# Runs from the SessionStart hook in .claude/settings.json after the repo
# has been cloned. No-op outside the cloud sandbox.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

corepack enable
corepack prepare pnpm@9 --activate

pnpm install --frozen-lockfile
pnpm migrate
