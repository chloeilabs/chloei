#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/node/bin:${PATH}"

read_env_var() {
  local key="$1"

  if [[ ! -f .env.local ]]; then
    return
  fi

  python3 - "$key" <<'PY'
from pathlib import Path
import shlex
import sys

key = sys.argv[1]
for line in Path(".env.local").read_text().splitlines():
    if line.startswith(f"{key}="):
        raw_value = line.split("=", 1)[1]
        parsed = shlex.split(f"value={raw_value}", comments=False, posix=True)
        value = parsed[0].split("=", 1)[1] if parsed else raw_value
        print(value)
        break
PY
}

EXISTING_DATABASE_URL="$(read_env_var "DATABASE_URL")"
EXISTING_BETTER_AUTH_URL="$(read_env_var "BETTER_AUTH_URL")"
EXISTING_BETTER_AUTH_SECRET="$(read_env_var "BETTER_AUTH_SECRET")"

DATABASE_URL_VALUE="${DATABASE_URL:-${EXISTING_DATABASE_URL:-postgresql://chloei:chloei_dev@localhost:5432/chloei}}"
BETTER_AUTH_URL_VALUE="${BETTER_AUTH_URL:-${EXISTING_BETTER_AUTH_URL:-http://localhost:3000}}"
BETTER_AUTH_SECRET_VALUE="${BETTER_AUTH_SECRET:-${EXISTING_BETTER_AUTH_SECRET:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")}}"

ensure_env_var() {
  local key="$1"
  local value="$2"

  if [[ -z "${value}" ]]; then
    return
  fi

  touch .env.local

  python3 - "$key" "$value" <<'PY'
from pathlib import Path
import shlex
import sys

key = sys.argv[1]
value = sys.argv[2]
path = Path(".env.local")
lines = path.read_text().splitlines()
env_line = f"{key}={shlex.quote(value)}"

updated_existing = False
updated = []
for line in lines:
    if line.startswith(f"{key}="):
        updated.append(env_line)
        updated_existing = True
    else:
        updated.append(line)

if not updated_existing:
    updated.append(env_line)

path.write_text("\n".join(updated) + "\n")
PY
}

ensure_env_var "DATABASE_URL" "${DATABASE_URL_VALUE}"
ensure_env_var "BETTER_AUTH_URL" "${BETTER_AUTH_URL_VALUE}"
ensure_env_var "BETTER_AUTH_SECRET" "${BETTER_AUTH_SECRET_VALUE}"

for key in AI_GATEWAY_API_KEY TAVILY_API_KEY FMP_API_KEY FRED_API_KEY SEC_API_USER_AGENT; do
  if [[ -n "${!key:-}" ]]; then
    ensure_env_var "${key}" "${!key}"
  fi
done

service postgresql start

su - postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='chloei'\"" | rg -q 1 || \
  su - postgres -c "psql -c \"CREATE ROLE chloei WITH LOGIN PASSWORD 'chloei_dev';\""

su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='chloei'\"" | rg -q 1 || \
  su - postgres -c "createdb -O chloei chloei"

corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium

export DATABASE_URL="${DATABASE_URL_VALUE}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL_VALUE}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET_VALUE}"
pnpm migrate
