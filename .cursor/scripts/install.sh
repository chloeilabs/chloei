#!/usr/bin/env bash
set -euo pipefail

source .cursor/scripts/node-toolchain.sh

ensure_node_toolchain
pnpm install --frozen-lockfile
