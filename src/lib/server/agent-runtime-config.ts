import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

// Request size limits (shared defaults).
export const AGENT_MAX_MESSAGES = AGENT_REQUEST_MAX_MESSAGES
export const AGENT_MAX_MESSAGE_CHARS = AGENT_REQUEST_MAX_MESSAGE_CHARS
export const AGENT_MAX_TOTAL_CHARS = AGENT_REQUEST_MAX_TOTAL_CHARS

// Timeouts (ms).
export const AGENT_STREAM_TIMEOUT_MS = 800_000
export const AI_GATEWAY_CLIENT_TIMEOUT_MS = 3_600_000

// Sliding-window rate limit + per-client concurrency.
export const AGENT_RATE_LIMIT_WINDOW_MS = 60_000
export const AGENT_RATE_LIMIT_MAX_REQUESTS = 60
export const AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = 4

// Tool-step budgets per runtime profile.
export const AGENT_TOOL_MAX_STEPS = 12
export const AGENT_RESEARCH_TOOL_MAX_STEPS = 20
export const AGENT_FINANCE_TOOL_MAX_STEPS = 20

function parseBooleanFromEnv(
  value: string | undefined,
  fallback: boolean
): boolean {
  const normalized = value?.trim().toLowerCase()
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

// Operational switches kept environment-configurable: a rate-limit kill switch
// and the persistence backend (memory vs. postgres) for tests and local runs.
export const AGENT_RATE_LIMIT_ENABLED = parseBooleanFromEnv(
  process.env.AGENT_RATE_LIMIT_ENABLED,
  true
)

export const AGENT_RATE_LIMIT_STORE = parseEnumFromEnv(
  process.env.AGENT_RATE_LIMIT_STORE,
  ["auto", "memory", "postgres"] as const,
  "auto"
)

// Code-execution backend. The finance/eval runtime profile selects "finance"
// per request; this env default only affects ad-hoc runs and the eval harness.
export const AGENT_CODE_EXECUTION_BACKEND = parseEnumFromEnv(
  process.env.AGENT_CODE_EXECUTION_BACKEND,
  ["restricted", "finance"] as const,
  "restricted"
)

export const AGENT_CODE_EXECUTION_PYTHON_VENV_PATH = parseOptionalStringFromEnv(
  process.env.AGENT_CODE_EXECUTION_PYTHON_VENV_PATH
)

// Eval-harness artifact output directory (set programmatically by the runner).
export const AGENT_EVAL_RESULTS_DIR = parseOptionalStringFromEnv(
  process.env.AGENT_EVAL_RESULTS_DIR
)
