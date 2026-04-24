const DEFAULT_AGENT_MAX_MESSAGES = 50
const DEFAULT_AGENT_MAX_MESSAGE_CHARS = 12_000
const DEFAULT_AGENT_MAX_TOTAL_CHARS = 48_000
const DEFAULT_AGENT_STREAM_TIMEOUT_MS = 800_000
const DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_AGENT_RATE_LIMIT_MAX_REQUESTS = 60
const DEFAULT_AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = 4
const DEFAULT_AGENT_TOOL_MAX_STEPS = 12

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

export const AGENT_TOOL_MAX_STEPS = parsePositiveIntFromEnv(
  process.env.AGENT_TOOL_MAX_STEPS,
  DEFAULT_AGENT_TOOL_MAX_STEPS
)
