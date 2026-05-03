#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/node-toolchain.sh"

ensure_node_toolchain
pnpm install --frozen-lockfile
