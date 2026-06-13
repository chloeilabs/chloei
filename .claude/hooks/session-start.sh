#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

: "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR must be set}"
cd "$CLAUDE_PROJECT_DIR"

# Consistent, prefixed logging helpers for hook output.
log() { echo "[session-start] $*"; }
warn() { echo "[session-start] WARN: $*" >&2; }

# ---------------------------------------------------------------------------
# Node 24 toolchain
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# PostgreSQL: make DATABASE_URL usable and apply migrations.
#
# Strategy (idempotent, best-effort — never blocks the session from starting):
#   1. If the configured DATABASE_URL is already reachable, use it as-is.
#   2. Otherwise start the container's native PostgreSQL. For a loopback or
#      known-placeholder host, provision a role/database that satisfy the
#      configured URL (mapping the placeholder host to localhost), so the exact
#      configured URL works without any code or settings change.
#   3. For any other unreachable host — including a real remote whose DNS is
#      momentarily failing — fall back to a local canonical DB and export it
#      for the session rather than silently redirecting it to localhost.
#   4. Run `pnpm migrate` (Better Auth + app schema) against the result.
# ---------------------------------------------------------------------------
CANONICAL_DB_URL="postgresql://chloei:chloei_dev@127.0.0.1:5432/chloei"

# Hostnames that only ever appear as unconfigured placeholders (e.g. the "host"
# in the shipped DATABASE_URL default). These are the only non-loopback hosts
# we will map to the local database; any other unresolvable host is treated as
# a real remote and sent to the canonical fallback instead.
PLACEHOLDER_DB_HOSTS="host"

# Return success when a Postgres connection string accepts a trivial query.
db_usable() {
  PGCONNECT_TIMEOUT=5 psql "$1" -tAc 'select 1' >/dev/null 2>&1
}

# Print one component (host|port|user|pass|name) parsed from a DB URL.
db_field() {
  node -e 'try{const u=new URL(process.argv[1]);const f=process.argv[2];const m={host:u.hostname,port:u.port||"5432",user:decodeURIComponent(u.username||""),pass:decodeURIComponent(u.password||""),name:decodeURIComponent((u.pathname||"").replace(/^\//,""))};process.stdout.write(String(m[f]??""));}catch(e){process.exit(1);}' "$1" "$2"
}

# True when the value is a bare SQL identifier safe to interpolate unquoted.
valid_ident() {
  printf '%s' "$1" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'
}

# True for loopback hosts that always refer to the local machine.
is_loopback_host() {
  case "$1" in
    localhost|127.*|::1|0.0.0.0) return 0 ;;
  esac
  return 1
}

# True only for the known placeholder hostnames in PLACEHOLDER_DB_HOSTS. A real
# remote host that merely fails to resolve must NOT match here, so it is never
# silently redirected to the local database.
is_placeholder_host() {
  case " $PLACEHOLDER_DB_HOSTS " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Start the native PostgreSQL service and wait until it accepts connections.
start_local_postgres() {
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    return 0
  fi
  sudo -n service postgresql start >/dev/null 2>&1 \
    || sudo -n pg_ctlcluster 16 main start >/dev/null 2>&1 \
    || true
  local i=0
  until pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      warn "local PostgreSQL did not become ready"
      return 1
    fi
    sleep 1
  done
  return 0
}

# Create a login role (or reset its password) with the given credentials.
ensure_role() {
  local role="$1" pw="$2" esc
  esc="${pw//\'/\'\'}"
  if sudo -n -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${role}'" 2>/dev/null | grep -q 1; then
    sudo -n -u postgres psql -c "ALTER ROLE \"${role}\" WITH LOGIN PASSWORD '${esc}';" >/dev/null 2>&1 \
      || warn "could not set password for role ${role}"
  else
    sudo -n -u postgres psql -c "CREATE ROLE \"${role}\" WITH LOGIN CREATEDB PASSWORD '${esc}';" >/dev/null 2>&1 \
      || warn "could not create role ${role}"
  fi
}

# Create a database owned by the given role if it does not already exist.
ensure_db() {
  local name="$1" owner="$2"
  if ! sudo -n -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'" 2>/dev/null | grep -q 1; then
    sudo -n -u postgres createdb -O "${owner}" "${name}" >/dev/null 2>&1 \
      || warn "could not create database ${name}"
  fi
}

# Point a known placeholder host at 127.0.0.1 (only when it does not already
# resolve) so the shipped placeholder DATABASE_URL connects to local Postgres.
# Non-placeholder hosts are left untouched.
map_host_to_localhost() {
  local host="$1"
  [ -n "$host" ] || return 0
  is_placeholder_host "$host" || return 0
  if getent hosts "$host" >/dev/null 2>&1; then
    return 0
  fi
  if ! grep -qiE "[[:space:]]${host}([[:space:]]|\$)" /etc/hosts 2>/dev/null; then
    if echo "127.0.0.1 ${host}" | sudo -n tee -a /etc/hosts >/dev/null 2>&1; then
      log "mapped placeholder DB host '${host}' to 127.0.0.1 in /etc/hosts"
    fi
  fi
}

# Provision a local role + database matching a loopback / placeholder URL so
# the exact configured DATABASE_URL becomes usable.
provision_configured_local() {
  local url="$1" host user pass name
  host="$(db_field "$url" host)" || return 1
  user="$(db_field "$url" user)"
  pass="$(db_field "$url" pass)"
  name="$(db_field "$url" name)"
  map_host_to_localhost "$host"
  if [ -n "$user" ] && [ -n "$name" ] && valid_ident "$user" && valid_ident "$name"; then
    ensure_role "$user" "$pass"
    ensure_db "$name" "$user"
  else
    log "configured DB credentials not safely provisionable; relying on canonical fallback"
  fi
}

# Apply Better Auth + app migrations, retrying a few times before giving up.
run_migrations() {
  local i=0
  while true; do
    if pnpm migrate; then
      log "database migrations applied"
      return 0
    fi
    i=$((i + 1))
    if [ "$i" -ge 3 ]; then
      warn "pnpm migrate failed after ${i} attempts"
      return 1
    fi
    log "migrate attempt ${i} failed; retrying"
    sleep $((i * 2))
  done
}

# Orchestrate database provisioning and migrations (best-effort).
setup_database() {
  if ! command -v psql >/dev/null 2>&1; then
    warn "psql not available; skipping database setup"
    return 0
  fi

  local configured="${DATABASE_URL:-}"

  if [ -n "$configured" ] && db_usable "$configured"; then
    log "configured DATABASE_URL is reachable; using as-is"
  else
    if ! start_local_postgres; then
      warn "could not start a local database; set a reachable DATABASE_URL"
      return 0
    fi

    # Always have the canonical local role/db available as a fallback target.
    ensure_role "chloei" "chloei_dev"
    ensure_db "chloei" "chloei"

    # Honor the configured URL locally only for loopback or known placeholder
    # hosts. Any other unresolvable host is a real remote and must fall through
    # to the explicit canonical fallback rather than be redirected to localhost.
    local host
    host="$(db_field "$configured" host 2>/dev/null || echo "")"
    if [ -n "$configured" ] && { is_loopback_host "$host" || is_placeholder_host "$host"; }; then
      provision_configured_local "$configured"
    fi

    if [ -n "$configured" ] && db_usable "$configured"; then
      log "configured DATABASE_URL is now usable via the local database"
    else
      log "configured DATABASE_URL unreachable; falling back to local DB (${CANONICAL_DB_URL})"
      export DATABASE_URL="$CANONICAL_DB_URL"
      export AUTH_DATABASE_URL="$CANONICAL_DB_URL"
      if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        {
          echo "export DATABASE_URL='${CANONICAL_DB_URL}'"
          echo "export AUTH_DATABASE_URL='${CANONICAL_DB_URL}'"
        } >> "$CLAUDE_ENV_FILE"
      fi
    fi
  fi

  run_migrations || true
}

# ---------------------------------------------------------------------------
# Playwright browsers (for `pnpm test:smoke:*`).
#
# `playwright install` stalls behind this environment's egress proxy (the
# download reaches 100% but the connection never closes), so we resolve the
# required builds via `--dry-run` and fetch each archive with curl, which
# terminates cleanly on Content-Length.
# ---------------------------------------------------------------------------
# Download, verify, and unpack a single Playwright browser build, writing the
# completion markers Playwright uses to consider it installed. Idempotent.
install_browser() {
  local loc="$1" url="$2" tmp
  if [ -z "$loc" ] || [ -z "$url" ]; then
    return 0
  fi
  if [ -f "$loc/INSTALLATION_COMPLETE" ] \
    && find "$loc" -maxdepth 3 -type f \
         \( -name chrome -o -name chrome-headless-shell -o -name 'ffmpeg*' \) \
         -perm -u+x 2>/dev/null | grep -q .; then
    return 0
  fi
  tmp="$(mktemp -d)"
  log "fetching browser build $(basename "$loc")"
  if ! curl -fSsL --retry 3 --retry-delay 2 --max-time 600 -o "$tmp/build.zip" "$url"; then
    warn "failed to download $url"
    rm -rf "$tmp"
    return 0
  fi
  if ! unzip -tq "$tmp/build.zip" >/dev/null 2>&1; then
    warn "downloaded archive failed integrity check: $url"
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$loc"
  mkdir -p "$loc"
  unzip -q "$tmp/build.zip" -d "$loc"
  touch "$loc/INSTALLATION_COMPLETE" "$loc/DEPENDENCIES_VALIDATED"
  rm -rf "$tmp"
  log "installed browser build $(basename "$loc")"
}

# Resolve the browser builds Playwright needs and install any that are missing.
setup_playwright() {
  if ! command -v unzip >/dev/null 2>&1; then
    warn "unzip not available; skipping Playwright browser setup"
    return 0
  fi
  local plan
  if ! plan="$(pnpm exec playwright install chromium --dry-run 2>/dev/null)"; then
    warn "could not resolve Playwright browser builds"
    return 0
  fi
  local pairs
  pairs="$(awk '
    /Install location:/ { loc = $3 }
    /Download url:/ { if (loc != "") { print loc "\t" $3; loc = "" } }
  ' <<<"$plan")"
  [ -n "$pairs" ] || return 0
  while IFS=$'\t' read -r loc url; do
    install_browser "$loc" "$url"
  done <<<"$pairs"
}

setup_database || true
setup_playwright || true

log "session start hook complete"
