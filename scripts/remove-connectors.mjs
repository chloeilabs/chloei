#!/usr/bin/env node

import { existsSync } from "node:fs"
import process from "node:process"

import { Client } from "pg"

const CONNECTOR_TOOL_NAMES = [
  "composio_search_tools",
  "composio_get_tool_schemas",
  "composio_manage_connections",
  "composio_multi_execute",
  "composio_remote_workbench",
  "composio_remote_bash",
]

const CONNECTOR_TOOL_NAME_SET = new Set(CONNECTOR_TOOL_NAMES)
const LEGACY_INBOX_THREAD_ID = "composio-inbox"
const LEGACY_WEBHOOK_MODEL = "composio_webhook"
const LEGACY_TRIGGER_THREAD_PREFIX = "composio-trigger-"
const DEFAULT_API_BASE_URL = "https://backend.composio.dev"
const EMPTY_OBJECT = Object.freeze({})

function loadEnvFiles() {
  for (const envFile of [".env", ".env.local"]) {
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile)
    }
  }
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null
}

function asString(value) {
  return typeof value === "string" ? value : null
}

function getStringArray(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    const normalized = asString(entry)?.trim()
    return normalized ? [normalized] : []
  })
}

function hasConnectorToolUsage(messages) {
  if (!Array.isArray(messages)) {
    return false
  }

  return messages.some((message) => {
    const record = asRecord(message)
    if (!record) {
      return false
    }

    if (asString(record.llmModel) === LEGACY_WEBHOOK_MODEL) {
      return true
    }

    const metadata = asRecord(record.metadata)
    if (!metadata) {
      return false
    }

    const toolInvocations = Array.isArray(metadata.toolInvocations)
      ? metadata.toolInvocations
      : []
    if (
      toolInvocations.some((invocation) =>
        CONNECTOR_TOOL_NAME_SET.has(
          asString(asRecord(invocation)?.toolName) ?? ""
        )
      )
    ) {
      return true
    }

    const activityTimeline = Array.isArray(metadata.activityTimeline)
      ? metadata.activityTimeline
      : []

    return activityTimeline.some((entry) =>
      CONNECTOR_TOOL_NAME_SET.has(asString(asRecord(entry)?.toolName) ?? "")
    )
  })
}

function hasLegacyTriggerIdentity(threadId, messages) {
  if (threadId.startsWith(LEGACY_TRIGGER_THREAD_PREFIX)) {
    return true
  }

  if (!Array.isArray(messages)) {
    return false
  }

  return messages.some((message) => {
    const messageId = asString(asRecord(message)?.id)?.trim() ?? ""
    return messageId.startsWith(LEGACY_TRIGGER_THREAD_PREFIX)
  })
}

function hasLegacyConfigFootprint(agentConfig) {
  const record = asRecord(agentConfig)
  if (!record) {
    return false
  }

  return (
    getStringArray(record.selectedToolkits).length > 0 ||
    typeof record.mode === "string" ||
    typeof record.enableWorkbench === "boolean" ||
    asRecord(record.pendingApproval) !== null
  )
}

function getPendingApprovalToolName(agentConfig) {
  const record = asRecord(agentConfig)
  const pendingApproval = asRecord(record?.pendingApproval)
  return asString(pendingApproval?.toolName)?.trim() ?? null
}

export function classifyThreadCleanupAction(thread) {
  const reasons = []
  const threadId = asString(thread?.id)?.trim() ?? ""
  const messages = Array.isArray(thread?.messages) ? thread.messages : []
  const agentConfig = asRecord(thread?.agentConfig) ?? EMPTY_OBJECT

  if (threadId === LEGACY_INBOX_THREAD_ID) {
    reasons.push("legacy_inbox_thread")
  }

  if (hasLegacyTriggerIdentity(threadId, messages)) {
    reasons.push("legacy_trigger_thread")
  }

  if (hasConnectorToolUsage(messages)) {
    reasons.push("connector_tool_activity")
  }

  const pendingApprovalToolName = getPendingApprovalToolName(agentConfig)
  if (
    pendingApprovalToolName &&
    CONNECTOR_TOOL_NAME_SET.has(pendingApprovalToolName)
  ) {
    reasons.push("connector_pending_approval")
  }

  if (reasons.length > 0) {
    return {
      action: "delete",
      reasons,
    }
  }

  if (hasLegacyConfigFootprint(agentConfig)) {
    return {
      action: "rewrite",
      reasons: ["legacy_connector_config"],
    }
  }

  return {
    action: "ignore",
    reasons: [],
  }
}

function createApiHeaders(apiKey) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  }
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options)
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    const payloadMessage = asString(payload?.message)
    const errorMessage =
      payloadMessage !== null && payloadMessage !== ""
        ? payloadMessage
        : text || "Unknown error"
    throw new Error(
      `Legacy connector API request failed (${String(response.status)}): ${errorMessage}`
    )
  }

  return payload
}

async function listConnectedAccounts(fetchImpl, baseUrl, apiKey) {
  const accounts = []
  let cursor = null

  for (;;) {
    const url = new URL("/api/v3/connected_accounts", baseUrl)
    url.searchParams.set("limit", "100")
    if (cursor) {
      url.searchParams.set("cursor", cursor)
    }

    const payload = await requestJson(fetchImpl, url, {
      headers: createApiHeaders(apiKey),
    })
    const items = Array.isArray(payload?.items) ? payload.items : []
    accounts.push(...items)

    const nextCursor = asString(payload?.next_cursor)?.trim() ?? null
    if (!nextCursor) {
      return accounts
    }

    cursor = nextCursor
  }
}

async function listActiveTriggers(fetchImpl, baseUrl, apiKey) {
  const triggers = []
  let cursor = null

  for (;;) {
    const url = new URL("/api/v3/trigger_instances/active", baseUrl)
    url.searchParams.set("limit", "100")
    if (cursor) {
      url.searchParams.set("cursor", cursor)
    }

    const payload = await requestJson(fetchImpl, url, {
      headers: createApiHeaders(apiKey),
    })
    const items = Array.isArray(payload?.items) ? payload.items : []
    triggers.push(...items)

    const nextCursor = asString(payload?.next_cursor)?.trim() ?? null
    if (!nextCursor) {
      return triggers
    }

    cursor = nextCursor
  }
}

async function deleteConnectedAccount(fetchImpl, baseUrl, apiKey, accountId) {
  const url = new URL(
    `/api/v3/connected_accounts/${encodeURIComponent(accountId)}`,
    baseUrl
  )

  await requestJson(fetchImpl, url, {
    method: "DELETE",
    headers: createApiHeaders(apiKey),
  })
}

async function deleteActiveTrigger(fetchImpl, baseUrl, apiKey, triggerId) {
  const url = new URL(
    `/api/v3/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
    baseUrl
  )

  await requestJson(fetchImpl, url, {
    method: "DELETE",
    headers: createApiHeaders(apiKey),
  })
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    [tableName]
  )

  return result.rows[0]?.exists === true
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
      ) AS exists
    `,
    [tableName, columnName]
  )

  return result.rows[0]?.exists === true
}

async function loadThreadRows(client, hasAgentConfigColumn) {
  const selectAgentConfig = hasAgentConfigColumn ? `, "agentConfig"` : ""
  const result = await client.query(`
    SELECT
      "userId",
      id,
      title,
      messages,
      "createdAt",
      "updatedAt"
      ${selectAgentConfig}
    FROM thread
  `)

  return result.rows.map((row) => ({
    ...row,
    agentConfig: hasAgentConfigColumn ? row.agentConfig : EMPTY_OBJECT,
  }))
}

async function countTableRows(client, tableName, whereClause = "", values = []) {
  if (!(await tableExists(client, tableName))) {
    return 0
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM ${tableName} ${whereClause}`,
    values
  )

  return Number(result.rows[0]?.count ?? 0)
}

function printSummary(summary) {
  const lines = [
    `Connected accounts: ${String(summary.connectedAccounts)}`,
    `Active triggers: ${String(summary.activeTriggers)}`,
    `Threads to delete: ${String(summary.threadsToDelete)}`,
    `Threads to rewrite: ${String(summary.threadsToRewrite)}`,
    `Webhook rows: ${String(summary.webhookRows)}`,
    `Queued jobs: ${String(summary.queuedJobs)}`,
  ]

  console.log(lines.join("\n"))
}

async function main() {
  loadEnvFiles()

  const mode = process.argv.includes("--apply")
    ? "apply"
    : process.argv.includes("--dry-run")
      ? "dry-run"
      : null

  if (!mode) {
    console.error("Usage: node scripts/remove-connectors.mjs --dry-run|--apply")
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()
  const apiKey = process.env.COMPOSIO_API_KEY?.trim()
  const baseUrl = process.env.COMPOSIO_BASE_URL?.trim() || DEFAULT_API_BASE_URL

  if (!databaseUrl) {
    console.error("Missing DATABASE_URL.")
    process.exit(1)
  }

  if (!apiKey) {
    console.error("Missing COMPOSIO_API_KEY.")
    process.exit(1)
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    const hasThreadTable = await tableExists(client, "thread")
    const hasAgentConfigColumn = hasThreadTable
      ? await columnExists(client, "thread", "agentConfig")
      : false

    const [connectedAccounts, activeTriggers] = await Promise.all([
      listConnectedAccounts(fetch, baseUrl, apiKey),
      listActiveTriggers(fetch, baseUrl, apiKey),
    ])
    const threadRows = hasThreadTable
      ? await loadThreadRows(client, hasAgentConfigColumn)
      : []
    const webhookRows = await countTableRows(client, "composio_webhook_event")
    const queuedJobs = await countTableRows(
      client,
      "agent_job",
      `WHERE source = $1`,
      ["composio_webhook"]
    )

    const threadsToDelete = []
    const threadsToRewrite = []

    for (const row of threadRows) {
      const decision = classifyThreadCleanupAction(row)
      if (decision.action === "delete") {
        threadsToDelete.push({ row, reasons: decision.reasons })
        continue
      }

      if (decision.action === "rewrite") {
        threadsToRewrite.push({ row, reasons: decision.reasons })
      }
    }

    printSummary({
      connectedAccounts: connectedAccounts.length,
      activeTriggers: activeTriggers.length,
      threadsToDelete: threadsToDelete.length,
      threadsToRewrite: threadsToRewrite.length,
      webhookRows,
      queuedJobs,
    })

    if (mode === "dry-run") {
      return
    }

    await client.query("BEGIN")

    for (const trigger of activeTriggers) {
      const triggerId = asString(trigger?.id)?.trim()
      if (!triggerId) {
        continue
      }

      await deleteActiveTrigger(fetch, baseUrl, apiKey, triggerId)
    }

    for (const account of connectedAccounts) {
      const accountId = asString(account?.id)?.trim()
      if (!accountId) {
        continue
      }

      await deleteConnectedAccount(fetch, baseUrl, apiKey, accountId)
    }

    for (const { row } of threadsToDelete) {
      await client.query(
        `DELETE FROM thread WHERE "userId" = $1 AND id = $2`,
        [row.userId, row.id]
      )
    }

    if (hasAgentConfigColumn) {
      for (const { row } of threadsToRewrite) {
        await client.query(
          `
            UPDATE thread
            SET
              "agentConfig" = '{}'::jsonb,
              "updatedAt" = GREATEST("updatedAt", $3::timestamp)
            WHERE "userId" = $1
              AND id = $2
          `,
          [row.userId, row.id, new Date().toISOString()]
        )
      }
    }

    if (await tableExists(client, "composio_webhook_event")) {
      await client.query(`DELETE FROM composio_webhook_event`)
    }

    if (await tableExists(client, "agent_job")) {
      await client.query(`DELETE FROM agent_job WHERE source = $1`, [
        "composio_webhook",
      ])
    }

    await client.query("COMMIT")
    console.log("Cleanup applied.")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

export { CONNECTOR_TOOL_NAMES }
