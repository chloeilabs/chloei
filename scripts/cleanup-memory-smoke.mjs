import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

import { Client } from "pg"

import { normalizePostgresConnectionString } from "../src/lib/server/postgres-url.mjs"

const DEFAULT_MEM0_API_URL = "http://localhost:8888"
const DEFAULT_MEMORY_AGENT_ID = "chloei"
const SMOKE_MEMORY_MARKER = "chloei-memory-smoke-"

function loadDotEnvLocal() {
  for (const envFile of [".env", ".env.local"]) {
    if (!existsSync(envFile)) {
      continue
    }

    for (const line of readFileSync(envFile, "utf8").split(/\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!match || process.env[match[1]]) {
        continue
      }

      let value = match[2]
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[match[1]] = value
    }
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for pnpm mem0:cleanup-smoke.`)
  }

  return value
}

function getMem0Mode(apiUrl) {
  try {
    return new URL(apiUrl).hostname === "api.mem0.ai" ? "platform" : "oss"
  } catch {
    return "oss"
  }
}

function getMem0Url(apiUrl, pathname) {
  const baseUrl = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`
  return new URL(pathname.replace(/^\//, ""), baseUrl)
}

function getMem0Headers(apiKey, mode) {
  const headers = {
    Accept: "application/json",
  }
  if (mode === "platform") {
    headers.Authorization = `Token ${apiKey}`
  } else {
    headers["X-API-Key"] = apiKey
  }

  return headers
}

async function resolveSmokeUserId(databaseUrl, smokeEmail) {
  const client = new Client({
    connectionString: normalizePostgresConnectionString(databaseUrl),
  })

  await client.connect()
  try {
    const result = await client.query(
      'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
      [smokeEmail]
    )
    return result.rows[0]?.id ?? null
  } finally {
    await client.end()
  }
}

async function deleteSmokeThreads(databaseUrl, userId) {
  const client = new Client({
    connectionString: normalizePostgresConnectionString(databaseUrl),
  })

  await client.connect()
  try {
    const result = await client.query(
      `DELETE FROM thread
       WHERE "userId" = $1
         AND messages::text LIKE $2
       RETURNING id`,
      [userId, `%${SMOKE_MEMORY_MARKER}%`]
    )
    return result.rowCount ?? 0
  } finally {
    await client.end()
  }
}

async function deleteMemoryScope(params) {
  const url = getMem0Url(
    params.apiUrl,
    params.mode === "platform" ? "v1/memories/" : "memories"
  )

  for (const [key, value] of Object.entries(params.scope)) {
    if (value) {
      url.searchParams.set(key, value)
    }
  }

  const response = await fetch(url, {
    headers: getMem0Headers(params.apiKey, params.mode),
    method: "DELETE",
  })

  return {
    description: params.description,
    ok: response.ok,
    status: response.status,
  }
}

async function deleteSmokeMemories(params) {
  const scopes =
    params.mode === "platform"
      ? [
          {
            description: "canonical metadata agent scope",
            scope: {
              metadata: JSON.stringify({ agent_id: params.agentId }),
              user_id: params.userId,
            },
          },
          {
            description: "canonical top-level agent scope",
            scope: {
              agent_id: params.agentId,
              user_id: params.userId,
            },
          },
          {
            description: "legacy app scope",
            scope: {
              app_id: `${params.agentId}:${params.userId}`,
            },
          },
        ]
      : [
          {
            description: "oss user agent scope",
            scope: {
              agent_id: params.agentId,
              user_id: params.userId,
            },
          },
        ]

  const results = []
  for (const scope of scopes) {
    results.push(
      await deleteMemoryScope({
        apiKey: params.apiKey,
        apiUrl: params.apiUrl,
        description: scope.description,
        mode: params.mode,
        scope: scope.scope,
      })
    )
  }

  if (results.every((result) => !result.ok)) {
    throw new Error("All Mem0 smoke memory cleanup scopes failed.")
  }

  return results
}

function hashUserId(userId) {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12)
}

async function main() {
  loadDotEnvLocal()

  const memoryProvider = requireEnv("MEMORY_PROVIDER")
  if (memoryProvider !== "mem0") {
    throw new Error("MEMORY_PROVIDER must be mem0 for pnpm mem0:cleanup-smoke.")
  }

  const databaseUrl = requireEnv("DATABASE_URL")
  const smokeEmail = requireEnv("SMOKE_EMAIL")
  const apiUrl = process.env.MEM0_API_URL?.trim() || DEFAULT_MEM0_API_URL
  const apiKey = requireEnv("MEM0_API_KEY")
  const mode = getMem0Mode(apiUrl)
  const agentId = process.env.MEMORY_AGENT_ID?.trim() || DEFAULT_MEMORY_AGENT_ID
  const userId = await resolveSmokeUserId(databaseUrl, smokeEmail)

  if (!userId) {
    console.log("Memory smoke cleanup skipped: smoke user was not found.")
    return
  }

  const deletedSmokeThreads = await deleteSmokeThreads(databaseUrl, userId)
  const mem0DeleteScopes = await deleteSmokeMemories({
    agentId,
    apiKey,
    apiUrl,
    mode,
    userId,
  })

  console.log(
    JSON.stringify(
      {
        agentId,
        deletedSmokeThreads,
        mem0DeleteScopes,
        mode,
        smokeUserHash: hashUserId(userId),
      },
      null,
      2
    )
  )
}

await main()
