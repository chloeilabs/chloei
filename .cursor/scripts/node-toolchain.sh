#!/usr/bin/env bash
set -euo pipefail

NODE_INSTALL_DIR="/usr/local/node"
NODE_MAJOR_VERSION="24"
PNPM_VERSION="10.32.1"

export PATH="${NODE_INSTALL_DIR}/bin:${PATH}"

install_node() {
  local arch
  local node_arch
  local node_version
  local tmpdir

  arch="$(uname -m)"
  case "$arch" in
    x86_64)
      node_arch="x64"
      ;;
    aarch64 | arm64)
      node_arch="arm64"
      ;;
    *)
      echo "Unsupported architecture for Node.js install: ${arch}" >&2
      return 1
      ;;
  esac

  node_version="$(
    curl -fsSL https://nodejs.org/dist/index.json |
      NODE_MAJOR_VERSION="$NODE_MAJOR_VERSION" python3 -c 'import json, os, sys; versions = json.load(sys.stdin); major = os.environ["NODE_MAJOR_VERSION"]; print(next(v["version"] for v in versions if v["version"].startswith(f"v{major}.")))'
  )"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  curl -fsSL "https://nodejs.org/dist/${node_version}/node-${node_version}-linux-${node_arch}.tar.xz" \
    -o "${tmpdir}/node.tar.xz"
  mkdir -p "$NODE_INSTALL_DIR"
  tar -xJf "${tmpdir}/node.tar.xz" -C "$NODE_INSTALL_DIR" --strip-components=1
}

ensure_node_toolchain() {
  if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v${NODE_MAJOR_VERSION}.* ]]; then
    install_node
    export PATH="${NODE_INSTALL_DIR}/bin:${PATH}"
  fi

  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
}
