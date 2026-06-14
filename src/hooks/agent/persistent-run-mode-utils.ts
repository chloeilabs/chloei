import { AGENT_RUN_MODES, type AgentRunMode } from "@/lib/shared"

const STORED_RUN_MODE_VERSION = 1

interface StoredRunMode {
  runMode: AgentRunMode
  source: "user"
  version: typeof STORED_RUN_MODE_VERSION
}

function isAgentRunMode(value: unknown): value is AgentRunMode {
  return (
    typeof value === "string" &&
    (AGENT_RUN_MODES as readonly string[]).includes(value)
  )
}

export function serializeStoredRunMode(runMode: AgentRunMode): StoredRunMode {
  return {
    runMode,
    source: "user",
    version: STORED_RUN_MODE_VERSION,
  }
}

export function parseStoredRunMode(value: unknown): AgentRunMode | null {
  if (typeof value !== "string") {
    return null
  }

  if (isAgentRunMode(value)) {
    return value
  }

  try {
    const parsed: unknown = JSON.parse(value)

    if (
      parsed &&
      typeof parsed === "object" &&
      "runMode" in parsed &&
      "source" in parsed &&
      "version" in parsed &&
      parsed.source === "user" &&
      parsed.version === STORED_RUN_MODE_VERSION &&
      isAgentRunMode(parsed.runMode)
    ) {
      return parsed.runMode
    }
  } catch {
    return null
  }

  return null
}

export function resolvePersistedRunMode(params: {
  storedRunMode: AgentRunMode | null
  currentRunMode?: AgentRunMode | null
  fallbackRunMode?: AgentRunMode
}): AgentRunMode {
  return (
    params.storedRunMode ??
    params.currentRunMode ??
    params.fallbackRunMode ??
    "chat"
  )
}
