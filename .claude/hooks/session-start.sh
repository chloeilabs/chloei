#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

: "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR must be set}"
cd "$CLAUDE_PROJECT_DIR"

corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@10.32.1 --activate >/dev/null 2>&1

actual_pnpm_version="$(pnpm --version)"
if [ "$actual_pnpm_version" != "10.32.1" ]; then
  echo "Expected pnpm 10.32.1, got $actual_pnpm_version" >&2
  exit 1
fi

pnpm install --frozen-lockfile
