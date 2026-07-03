import { createLogger } from "@/lib/logger"

const logger = createLogger("integration-flags")

export const AGENT_FLAG_KEYS = [
  "agent.telemetry.record_io",
  "agent.response.compaction",
  "agent.responses.ws_transport",
  "agent.goblins.adaptive",
  "agent.goblins.hosted_tools",
  "agent.goblins.background_escalation",
] as const

type AgentFlagKey = (typeof AGENT_FLAG_KEYS)[number]
type IntegrationFlagKey = AgentFlagKey

export interface AgentFeatureFlags {
  telemetryRecordIo: boolean
  // Enables OpenAI server-side context compaction within a run (long agentic
  // loops). Default off; opt in per environment.
  responseCompaction: boolean
  // Routes Responses API traffic over a persistent WebSocket instead of HTTP,
  // cutting per-round-trip overhead on tool-heavy runs. Default off.
  responsesWebsocketTransport: boolean
  // Goblins adaptive orchestration: triage tiers, multi-round delegation,
  // coverage evaluator, shared research state. Default off.
  goblinsAdaptive: boolean
  // Goblins hosted tools: OpenAI web_search / file_search / code_interpreter
  // on the specialist sub-agents. Default off.
  goblinsHostedTools: boolean
  // Goblins background escalation: durable deep-research runs driven by
  // background responses + webhooks. Default off.
  goblinsBackgroundEscalation: boolean
}

const DEFAULT_FLAGS: AgentFeatureFlags = {
  telemetryRecordIo: false,
  responseCompaction: false,
  responsesWebsocketTransport: false,
  goblinsAdaptive: false,
  goblinsHostedTools: false,
  goblinsBackgroundEscalation: false,
}

const ENV_FLAG_NAMES: Record<keyof AgentFeatureFlags, string> = {
  telemetryRecordIo: "AGENT_TELEMETRY_RECORD_IO",
  responseCompaction: "AGENT_RESPONSE_COMPACTION",
  responsesWebsocketTransport: "AGENT_RESPONSES_WS_TRANSPORT",
  goblinsAdaptive: "AGENT_GOBLINS_ADAPTIVE",
  goblinsHostedTools: "AGENT_GOBLINS_HOSTED_TOOLS",
  goblinsBackgroundEscalation: "AGENT_GOBLINS_BACKGROUND_ESCALATION",
}

const EDGE_FLAG_KEYS: Record<keyof AgentFeatureFlags, IntegrationFlagKey> = {
  telemetryRecordIo: "agent.telemetry.record_io",
  responseCompaction: "agent.response.compaction",
  responsesWebsocketTransport: "agent.responses.ws_transport",
  goblinsAdaptive: "agent.goblins.adaptive",
  goblinsHostedTools: "agent.goblins.hosted_tools",
  goblinsBackgroundEscalation: "agent.goblins.background_escalation",
}

export function toEdgeConfigFlagKey(key: IntegrationFlagKey): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_")
}

export function toVercelFlagSlug(key: IntegrationFlagKey): string {
  return key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value !== "string") {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false
  }

  return null
}

function getEnvFlag(name: string): boolean | null {
  return parseBooleanFlag(process.env[name])
}

function parseFlagMapValue(
  flagMap: unknown,
  key: IntegrationFlagKey
): boolean | null {
  if (!flagMap || typeof flagMap !== "object" || Array.isArray(flagMap)) {
    return null
  }

  const map = flagMap as Record<string, unknown>
  const vercelFlagSlug = toVercelFlagSlug(key)
  if (key in map) {
    return parseBooleanFlag(map[key])
  }

  if (vercelFlagSlug in map) {
    return parseBooleanFlag(map[vercelFlagSlug])
  }

  return null
}

async function getEdgeConfigFlag(
  key: IntegrationFlagKey
): Promise<boolean | null> {
  if (!process.env.EDGE_CONFIG?.trim()) {
    return null
  }

  try {
    const { get: getEdgeConfigValue } = await import("@vercel/edge-config")
    for (const mapKey of ["agent_flags", "analytics_flags", "flags"]) {
      const mapValue = parseFlagMapValue(await getEdgeConfigValue(mapKey), key)
      if (mapValue !== null) {
        return mapValue
      }
    }

    return (
      parseBooleanFlag(await getEdgeConfigValue(toEdgeConfigFlagKey(key))) ??
      parseBooleanFlag(await getEdgeConfigValue(toVercelFlagSlug(key)))
    )
  } catch (error) {
    logger.warn("Edge Config flag lookup failed; using local defaults.", {
      error,
      flagKey: key,
    })
    return null
  }
}

export async function resolveIntegrationBooleanFlag({
  defaultValue = false,
  envNames,
  key,
}: {
  defaultValue?: boolean
  envNames?: string[]
  key: IntegrationFlagKey
}): Promise<boolean> {
  for (const envName of envNames ?? []) {
    const envValue = getEnvFlag(envName)
    if (envValue !== null) {
      return envValue
    }
  }

  return (await getEdgeConfigFlag(key)) ?? defaultValue
}

export async function resolveAgentFeatureFlags(): Promise<AgentFeatureFlags> {
  const flags: AgentFeatureFlags = { ...DEFAULT_FLAGS }

  for (const key of Object.keys(flags) as (keyof AgentFeatureFlags)[]) {
    const envValue = getEnvFlag(ENV_FLAG_NAMES[key])
    if (envValue !== null) {
      flags[key] = envValue
      continue
    }

    const edgeValue = await getEdgeConfigFlag(EDGE_FLAG_KEYS[key])
    if (edgeValue !== null) {
      flags[key] = edgeValue
    }
  }

  return flags
}

export function getDefaultAgentFeatureFlags(): AgentFeatureFlags {
  return { ...DEFAULT_FLAGS }
}
