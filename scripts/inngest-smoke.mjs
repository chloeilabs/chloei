#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const DEFAULT_INNGEST_SMOKE_EVENT_NAME = "ops/inngest.smoke"
export const DEFAULT_INNGEST_EVENT_API_BASE_URL = "https://inn.gs/e"
const DEFAULT_TIMEOUT_MS = 15_000

function trimQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

export function parseDotEnv(content) {
  const parsed = {}
  for (const rawLine of content.split(/\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!match) {
      continue
    }

    parsed[match[1]] = trimQuotes(match[2].trim())
  }

  return parsed
}

export function loadEnvFile(
  filePath,
  env = process.env,
  { override = false } = {}
) {
  if (!existsSync(filePath)) {
    return false
  }

  const parsed = parseDotEnv(readFileSync(filePath, "utf8"))
  for (const [key, value] of Object.entries(parsed)) {
    if (override || !env[key]) {
      env[key] = value
    }
  }

  return true
}

function requireEnv(name, env = process.env) {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for pnpm inngest:smoke.`)
  }

  return value
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseArgs(args) {
  const options = {
    endpoint: DEFAULT_INNGEST_EVENT_API_BASE_URL,
    envFile: undefined,
    eventName: DEFAULT_INNGEST_SMOKE_EVENT_NAME,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true }
    }

    if (
      arg === "--endpoint" ||
      arg === "--env-file" ||
      arg === "--event-name" ||
      arg === "--timeout-ms"
    ) {
      const value = args[index + 1]
      if (!value) {
        throw new Error(`${arg} requires a value.`)
      }
      index += 1

      if (arg === "--endpoint") {
        options.endpoint = value
      } else if (arg === "--env-file") {
        options.envFile = value
      } else if (arg === "--event-name") {
        options.eventName = value
      } else {
        options.timeoutMs = parsePositiveInteger(value, DEFAULT_TIMEOUT_MS)
      }
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

export function buildSmokeEventPayload({
  eventName = DEFAULT_INNGEST_SMOKE_EVENT_NAME,
  now = new Date(),
  smokeId = `chloei-inngest-smoke-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
} = {}) {
  const sentAt = now.toISOString()
  return {
    data: {
      sentAt,
      smokeId,
      source: "chloei_inngest_smoke",
    },
    id: `${eventName}:${smokeId}`,
    name: eventName,
  }
}

export function buildEventApiUrl(endpoint, eventKey) {
  return `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(eventKey)}`
}

function printHelp() {
  console.log(`Usage: pnpm inngest:smoke [--env-file <path>] [--endpoint <url>]

Sends one no-op ${DEFAULT_INNGEST_SMOKE_EVENT_NAME} event to Inngest Cloud.

Required environment:
  INNGEST_EVENT_KEY

Options:
  --env-file <path>    Load env vars from a dotenv file before sending.
  --endpoint <url>     Event API base URL. Default: ${DEFAULT_INNGEST_EVENT_API_BASE_URL}
  --timeout-ms <ms>    Request timeout. Default: ${DEFAULT_TIMEOUT_MS}
`)
}

export async function sendSmokeEvent({
  endpoint,
  env = process.env,
  eventName,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const eventKey = requireEnv("INNGEST_EVENT_KEY", env)
  const payload = buildSmokeEventPayload({ eventName })
  const response = await fetchImpl(
    buildEventApiUrl(endpoint ?? DEFAULT_INNGEST_EVENT_API_BASE_URL, eventKey),
    {
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    }
  )
  const bodyText = await response.text()

  if (!response.ok) {
    throw new Error(
      `Inngest smoke event failed with HTTP ${response.status}: ${bodyText.slice(0, 500)}`
    )
  }

  const body = bodyText ? JSON.parse(bodyText) : null
  return {
    body,
    payload,
    status: response.status,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  loadEnvFile(".env")
  loadEnvFile(".env.local")
  if (options.envFile) {
    loadEnvFile(options.envFile, process.env, { override: true })
  }

  const result = await sendSmokeEvent({
    endpoint: options.endpoint,
    eventName: options.eventName,
    timeoutMs: options.timeoutMs,
  })

  console.log("Sent Inngest smoke event.")
  console.log(`Event name: ${result.payload.name}`)
  console.log(`Smoke ID: ${result.payload.data.smokeId}`)
  console.log(`HTTP status: ${result.status}`)
  console.log(
    `Inngest event IDs: ${
      Array.isArray(result.body?.ids) ? result.body.ids.join(", ") : "unknown"
    }`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
