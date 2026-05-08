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

function parseFloatFromEnv(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) {
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

export const AGENT_MEMORY_ENABLED = parseBooleanFromEnv(
  process.env.AGENT_MEMORY_ENABLED,
  true
)

export const AGENT_MEMORY_LLM_MODEL =
  process.env.AGENT_MEMORY_LLM_MODEL?.trim() ?? "anthropic/claude-haiku-4-5"

export const AGENT_MEMORY_SEARCH_TOP_K = parsePositiveIntFromEnv(
  process.env.AGENT_MEMORY_SEARCH_TOP_K,
  6
)

export const AGENT_MEMORY_SEARCH_THRESHOLD = parseFloatFromEnv(
  process.env.AGENT_MEMORY_SEARCH_THRESHOLD,
  0.25
)

export const AGENT_MEMORY_DEDUP_THRESHOLD = parseFloatFromEnv(
  process.env.AGENT_MEMORY_DEDUP_THRESHOLD,
  0.9
)

export const AGENT_MEMORY_MAX_FACTS_PER_TURN = parsePositiveIntFromEnv(
  process.env.AGENT_MEMORY_MAX_FACTS_PER_TURN,
  6
)
