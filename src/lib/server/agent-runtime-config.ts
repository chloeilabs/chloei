import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

const DEFAULT_AGENT_MAX_MESSAGES = AGENT_REQUEST_MAX_MESSAGES
const DEFAULT_AGENT_MAX_MESSAGE_CHARS = AGENT_REQUEST_MAX_MESSAGE_CHARS
const DEFAULT_AGENT_MAX_TOTAL_CHARS = AGENT_REQUEST_MAX_TOTAL_CHARS
const DEFAULT_AGENT_STREAM_TIMEOUT_MS = 800_000
const DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_AGENT_RATE_LIMIT_MAX_REQUESTS = 60
const DEFAULT_AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = 4
const DEFAULT_AGENT_RATE_LIMIT_STORE = "auto"
const DEFAULT_AGENT_TOOL_MAX_STEPS = 12
const DEFAULT_AGENT_RESEARCH_TOOL_MAX_STEPS = 20
const DEFAULT_AGENT_CODE_EXECUTION_BACKEND = "restricted"
const DEFAULT_AI_GATEWAY_CLIENT_TIMEOUT_MS = 3_600_000

function parsePositiveIntFromEnv(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function parseBooleanFromEnv(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "true") {
    return true
  }
  if (normalized === "false") {
    return false
  }

  return fallback
}

function parseEnumFromEnv<const T extends readonly string[]>(
  value: string | undefined,
  allowedValues: T,
  fallback: T[number]
): T[number] {
  const normalized = value?.trim()
  if (!normalized) {
    return fallback
  }

  return allowedValues.includes(normalized) ? normalized : fallback
}

function parseOptionalStringFromEnv(
  value: string | undefined
): string | undefined {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

export const AGENT_MAX_MESSAGES = parsePositiveIntFromEnv(
  process.env.AGENT_MAX_MESSAGES,
  DEFAULT_AGENT_MAX_MESSAGES
)

export const AGENT_MAX_MESSAGE_CHARS = parsePositiveIntFromEnv(
  process.env.AGENT_MAX_MESSAGE_CHARS,
  DEFAULT_AGENT_MAX_MESSAGE_CHARS
)

export const AGENT_MAX_TOTAL_CHARS = parsePositiveIntFromEnv(
  process.env.AGENT_MAX_TOTAL_CHARS,
  DEFAULT_AGENT_MAX_TOTAL_CHARS
)

export const AGENT_STREAM_TIMEOUT_MS = parsePositiveIntFromEnv(
  process.env.AGENT_STREAM_TIMEOUT_MS,
  DEFAULT_AGENT_STREAM_TIMEOUT_MS
)

export const AI_GATEWAY_CLIENT_TIMEOUT_MS = parsePositiveIntFromEnv(
  process.env.AI_GATEWAY_CLIENT_TIMEOUT_MS,
  DEFAULT_AI_GATEWAY_CLIENT_TIMEOUT_MS
)

export const AGENT_RATE_LIMIT_ENABLED = parseBooleanFromEnv(
  process.env.AGENT_RATE_LIMIT_ENABLED,
  true
)

export const AGENT_RATE_LIMIT_WINDOW_MS = parsePositiveIntFromEnv(
  process.env.AGENT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS
)

export const AGENT_RATE_LIMIT_MAX_REQUESTS = parsePositiveIntFromEnv(
  process.env.AGENT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_AGENT_RATE_LIMIT_MAX_REQUESTS
)

export const AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = parsePositiveIntFromEnv(
  process.env.AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  DEFAULT_AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT
)

export const AGENT_RATE_LIMIT_STORE = parseEnumFromEnv(
  process.env.AGENT_RATE_LIMIT_STORE,
  ["auto", "memory", "postgres"] as const,
  DEFAULT_AGENT_RATE_LIMIT_STORE
)

export const AGENT_TOOL_MAX_STEPS = parsePositiveIntFromEnv(
  process.env.AGENT_TOOL_MAX_STEPS,
  DEFAULT_AGENT_TOOL_MAX_STEPS
)

export const AGENT_RESEARCH_TOOL_MAX_STEPS = parsePositiveIntFromEnv(
  process.env.AGENT_RESEARCH_TOOL_MAX_STEPS,
  DEFAULT_AGENT_RESEARCH_TOOL_MAX_STEPS
)

export const AGENT_CODE_EXECUTION_BACKEND = parseEnumFromEnv(
  process.env.AGENT_CODE_EXECUTION_BACKEND,
  ["restricted", "finance"] as const,
  DEFAULT_AGENT_CODE_EXECUTION_BACKEND
)

export const AGENT_CODE_EXECUTION_PYTHON_VENV_PATH = parseOptionalStringFromEnv(
  process.env.AGENT_CODE_EXECUTION_PYTHON_VENV_PATH
)

export const AGENT_EVAL_RESULTS_DIR = parseOptionalStringFromEnv(
  process.env.AGENT_EVAL_RESULTS_DIR
)
