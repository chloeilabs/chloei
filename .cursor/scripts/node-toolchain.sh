#!/usr/bin/env bash
set -euo pipefail

NODE_INSTALL_DIR="/usr/local/node"
NODE_MAJOR_VERSION="24"
PNPM_VERSION="10.32.1"

export PATH="${NODE_INSTALL_DIR}/bin:${PATH}"

install_node() {
  local arch
  local expected_checksum
  local keyring_file
  local node_arch
  local node_tarball
  local node_version
  local shasums_asc_file
  local shasums_file
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
  trap 'rm -rf "$tmpdir"; trap - RETURN' RETURN
  node_tarball="node-${node_version}-linux-${node_arch}.tar.xz"
  shasums_file="${tmpdir}/SHASUMS256.txt"
  shasums_asc_file="${tmpdir}/SHASUMS256.txt.asc"
  keyring_file="${tmpdir}/nodejs-release-keyring.kbx"

  curl -fsSL "https://nodejs.org/dist/${node_version}/${node_tarball}" \
    -o "${tmpdir}/node.tar.xz"
  if command -v gpgv >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt.asc" \
      -o "$shasums_asc_file"
    curl -fsSL "https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx" \
      -o "$keyring_file"
    gpgv --keyring "$keyring_file" --output "$shasums_file" <"$shasums_asc_file"
  else
    curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" \
      -o "$shasums_file"
  fi

  expected_checksum="$(
    awk -v filename="$node_tarball" '$2 == filename { print $1 }' "$shasums_file"
  )"
  if [ -z "$expected_checksum" ]; then
    echo "Unable to find checksum for ${node_tarball}" >&2
    return 1
  fi

  printf '%s  %s\n' "$expected_checksum" "${tmpdir}/node.tar.xz" | sha256sum --check --status
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
