#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/node/bin:$PATH"

POSTGRES_CONTAINER_NAME="postgres"
POSTGRES_USER="chloei"
POSTGRES_PASSWORD="chloei_dev"
POSTGRES_DB="chloei"
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"

append_env_if_set() {
  local name="$1"

  if [ -n "${!name:-}" ]; then
    printf '%s=%s\n' "$name" "${!name}" >> .env.local
  fi
}

wait_for_docker() {
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

wait_for_postgres() {
  for _ in $(seq 1 30); do
    if docker exec "$POSTGRES_CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

start_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required for the Cursor Cloud Agent database setup." >&2
    return 1
  fi

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  mkdir -p /var/log
  dockerd >/var/log/dockerd.log 2>&1 &
  wait_for_docker
}

create_postgres() {
  docker run \
    -d \
    --name "$POSTGRES_CONTAINER_NAME" \
    -e "POSTGRES_USER=${POSTGRES_USER}" \
    -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
    -e "POSTGRES_DB=${POSTGRES_DB}" \
    -p 5432:5432 \
    -v postgres_data:/var/lib/postgresql/data \
    postgres:16-alpine >/dev/null
}

start_postgres() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER_NAME"; then
    if ! docker start "$POSTGRES_CONTAINER_NAME" >/dev/null 2>&1; then
      docker rm -f "$POSTGRES_CONTAINER_NAME" >/dev/null
      create_postgres
    fi
  else
    create_postgres
  fi

  wait_for_postgres
}

write_env_file() {
  cat > .env.local <<EOF
DATABASE_URL=${DATABASE_URL}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-cursor-cloud-agent-local-secret}
BETTER_AUTH_URL=http://localhost:3000
AGENT_RATE_LIMIT_STORE=memory
EOF

  append_env_if_set AI_GATEWAY_API_KEY
  append_env_if_set TAVILY_API_KEY
  append_env_if_set FMP_API_KEY
  append_env_if_set FRED_API_KEY
  append_env_if_set SEC_API_USER_AGENT
  append_env_if_set OPENAI_API_KEY
  append_env_if_set OPENAI_EVAL_JUDGE_MODEL
}

start_docker
start_postgres
write_env_file
pnpm migrate
