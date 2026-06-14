import { createLogger } from "@/lib/logger"

const logger = createLogger("integration-flags")

export const AGENT_FLAG_KEYS = [
  "agent.telemetry.record_io",
  "agent.finance_workflows.enabled",
] as const

type AgentFlagKey = (typeof AGENT_FLAG_KEYS)[number]
type IntegrationFlagKey = AgentFlagKey

export interface AgentFeatureFlags {
  telemetryRecordIo: boolean
  financeWorkflowsEnabled: boolean
}

interface ResolveAgentFeatureFlagsParams {
  userEmail?: string | null
}

const DEFAULT_FLAGS: AgentFeatureFlags = {
  telemetryRecordIo: false,
  financeWorkflowsEnabled: false,
}

const ENV_FLAG_NAMES: Record<keyof AgentFeatureFlags, string> = {
  telemetryRecordIo: "AGENT_TELEMETRY_RECORD_IO",
  financeWorkflowsEnabled: "AGENT_FINANCE_WORKFLOWS_ENABLED",
}

const EDGE_FLAG_KEYS: Record<keyof AgentFeatureFlags, IntegrationFlagKey> = {
  telemetryRecordIo: "agent.telemetry.record_io",
  financeWorkflowsEnabled: "agent.finance_workflows.enabled",
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

export function isInternalUser(email: string | null | undefined): boolean {
  const normalizedEmail = email?.trim().toLowerCase()
  if (!normalizedEmail) {
    return false
  }

  const configuredEmails = new Set(
    (process.env.AGENT_INTERNAL_USER_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
  if (configuredEmails.has(normalizedEmail)) {
    return true
  }

  const emailDomain = normalizedEmail.split("@")[1]
  if (!emailDomain) {
    return false
  }

  return (process.env.AGENT_INTERNAL_USER_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(emailDomain)
}

function getInternalDefaultFlags(
  params: ResolveAgentFeatureFlagsParams
): AgentFeatureFlags {
  if (!isInternalUser(params.userEmail)) {
    return DEFAULT_FLAGS
  }

  const internalDefault = parseBooleanFlag(
    process.env.AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS
  )
  if (internalDefault !== true) {
    return DEFAULT_FLAGS
  }

  return {
    ...DEFAULT_FLAGS,
    financeWorkflowsEnabled: true,
  }
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

export async function resolveAgentFeatureFlags(
  params: ResolveAgentFeatureFlagsParams = {}
): Promise<AgentFeatureFlags> {
  const flags: AgentFeatureFlags = { ...getInternalDefaultFlags(params) }

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
