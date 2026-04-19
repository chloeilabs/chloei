#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

: "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR must be set}"
cd "$CLAUDE_PROJECT_DIR"

current_node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$current_node_major" != "24" ]; then
  node_version="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ \
    | grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' \
    | head -1 | sed -E 's/node-v([0-9.]+)-.*/\1/')"
  if [ -z "$node_version" ]; then
    echo "Failed to discover latest Node 24 version" >&2
    exit 1
  fi

  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac

  node_dir="$HOME/.local/node-v$node_version-linux-$node_arch"
  if [ ! -x "$node_dir/bin/node" ]; then
    mkdir -p "$HOME/.local"
    curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$node_arch.tar.xz" \
      | tar -xJ -C "$HOME/.local"
  fi

  export PATH="$node_dir/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$node_dir/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@10.32.1 --activate >/dev/null 2>&1

actual_pnpm_version="$(pnpm --version)"
if [ "$actual_pnpm_version" != "10.32.1" ]; then
  echo "Expected pnpm 10.32.1, got $actual_pnpm_version" >&2
  exit 1
fi

pnpm install --frozen-lockfile
