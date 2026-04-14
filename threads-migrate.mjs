import { existsSync } from "node:fs"
import process from "node:process"

import { Client } from "pg"

import { normalizePostgresConnectionString } from "./src/lib/server/postgres-url.mjs"

for (const envFile of [".env", ".env.local"]) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile)
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim()
const LEGACY_EVENT_TABLE = ["comp", "osio_webhook_event"].join("")
const LEGACY_THREAD_CONFIG_COLUMN = ["agent", "Config"].join("")
const THREAD_STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS thread (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id text NOT NULL,
  title text NOT NULL,
  model text,
  "isPinned" boolean NOT NULL DEFAULT false,
  messages jsonb NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  PRIMARY KEY ("userId", id)
);

ALTER TABLE thread
ADD COLUMN IF NOT EXISTS "isPinned" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS thread_user_updated_at_idx
ON thread ("userId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS automation (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  model text,
  config jsonb NOT NULL,
  "isEnabled" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_user_updated_at_idx
ON automation ("userId", "updatedAt" DESC);

DROP TABLE IF EXISTS agent_job;
DROP TABLE IF EXISTS ${LEGACY_EVENT_TABLE};

ALTER TABLE thread
DROP COLUMN IF EXISTS "${LEGACY_THREAD_CONFIG_COLUMN}";
`

if (!databaseUrl) {
  console.error("Missing DATABASE_URL.")
  process.exit(1)
}

const client = new Client({
  connectionString: normalizePostgresConnectionString(databaseUrl),
})

await client.connect()

try {
  await client.query("BEGIN")
  await client.query(THREAD_STORAGE_SCHEMA_SQL)
  await client.query("COMMIT")
  console.log("Applied thread storage schema.")
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined)
  throw error
} finally {
  await client.end()
}
