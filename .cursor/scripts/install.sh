#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/node/bin:$PATH"

corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
