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
const APP_STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS thread (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id text NOT NULL,
  title text NOT NULL DEFAULT 'New Conversation',
  model text,
  messages jsonb NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  PRIMARY KEY ("userId", id)
);

CREATE INDEX IF NOT EXISTS thread_user_updated_at_idx
ON thread ("userId", "updatedAt" DESC);

ALTER TABLE thread
ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'New Conversation';

ALTER TABLE thread
ALTER COLUMN title SET DEFAULT 'New Conversation';

UPDATE thread
SET title = CASE
  WHEN NULLIF(BTRIM(COALESCE(messages -> 0 ->> 'content', '')), '') IS NULL
    THEN 'New Conversation'
  ELSE LEFT(BTRIM(COALESCE(messages -> 0 ->> 'content', '')), 50)
END
WHERE BTRIM(COALESCE(title, '')) = ''
   OR title = 'New Conversation';

DROP TABLE IF EXISTS agent_rate_limit;

DROP TABLE IF EXISTS ${LEGACY_EVENT_TABLE};

DROP TABLE IF EXISTS automation;

DROP TABLE IF EXISTS agent_job;

ALTER TABLE thread
DROP COLUMN IF EXISTS "${LEGACY_THREAD_CONFIG_COLUMN}";

-- Durable Goblins background research runs (agent.goblins.background_escalation).
-- One row per escalated run: OpenAI background-response chain cursors, the
-- lease that serializes continuation segments across invocations, recorded
-- goblin briefs (idempotent re-drives), and the append-only event log the
-- client replays on reconnect. Inert until the feature flag is enabled.
CREATE TABLE IF NOT EXISTS goblins_run (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "threadId" text NOT NULL,
  "assistantMessageId" text NOT NULL,
  status text NOT NULL,
  phase jsonb NOT NULL DEFAULT '{}',
  "openaiResponseId" text,
  "previousResponseId" text,
  "systemInstruction" text NOT NULL,
  input jsonb NOT NULL,
  "toolResults" jsonb NOT NULL DEFAULT '{}',
  events jsonb NOT NULL DEFAULT '[]',
  "eventCount" integer NOT NULL DEFAULT 0,
  "leaseOwner" text,
  "leaseExpiresAt" timestamptz,
  error text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS goblins_run_openai_response_idx
ON goblins_run ("openaiResponseId") WHERE "openaiResponseId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS goblins_run_user_thread_idx
ON goblins_run ("userId", "threadId");

-- Finance shares the auth database and stores additional thread metadata in
-- the shared thread table. Preserve compatible columns when Chloei migrations
-- rerun so cross-app storage stays stable.
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
  await client.query(APP_STORAGE_SCHEMA_SQL)
  await client.query("COMMIT")
  console.log("Applied app storage schema.")
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined)
  throw error
} finally {
  await client.end()
}
