import { createLogger } from "@/lib/logger"
import {
  type AgentFeatureFlags,
  type IntegrationFlagKey,
  isInternalUser,
  resolveIntegrationBooleanFlag,
  toVercelFlagSlug,
} from "@/lib/server/integration-flags"
import { hashPrivacyValue } from "@/lib/server/privacy"
import {
  type PostHogSafeProperties,
  scrubPostHogProperties,
} from "@/lib/shared/posthog-scrubbing"

const logger = createLogger("posthog-analytics")

const POSTHOG_CAPTURE_TIMEOUT_MS = 750
const POSTHOG_ANALYTICS_FLAG_KEY = "analytics.posthog.enabled" as const

export type PostHogProductEventName =
  | "agent_request_started"
  | "async_report_requested"
  | "document_uploaded"

function toNonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }

  return trimmed
}

export function resolvePostHogProjectToken(): string | null {
  return (
    toNonEmptyString(process.env.POSTHOG_PROJECT_API_KEY) ??
    toNonEmptyString(process.env.POSTHOG_PROJECT_TOKEN) ??
    toNonEmptyString(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) ??
    toNonEmptyString(process.env.NEXT_PUBLIC_POSTHOG_TOKEN) ??
    null
  )
}

function isPostHogInternalUsersOnly(): boolean {
  const normalized =
    process.env.POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY?.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return !["0", "false", "no", "off", "disabled"].includes(normalized)
}

function resolvePostHogHost(): string {
  return (
    toNonEmptyString(process.env.POSTHOG_HOST) ??
    toNonEmptyString(process.env.NEXT_PUBLIC_POSTHOG_HOST) ??
    "https://us.i.posthog.com"
  )
}

export async function isPostHogAnalyticsEnabled({
  userEmail,
}: {
  userEmail?: string | null
} = {}): Promise<boolean> {
  if (!resolvePostHogProjectToken()) {
    return false
  }

  const flagEnabled = await resolveIntegrationBooleanFlag({
    key: POSTHOG_ANALYTICS_FLAG_KEY,
    envNames: [
      "POSTHOG_ANALYTICS_ENABLED",
      "NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED",
    ],
    defaultValue: false,
  })

  if (!flagEnabled) {
    return false
  }

  if (isPostHogInternalUsersOnly() && !isInternalUser(userEmail)) {
    return false
  }

  return true
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`PostHog capture timed out after ${String(timeoutMs)}ms.`)
      )
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(
          error instanceof Error
            ? error
            : new Error("PostHog capture failed with a non-Error rejection.")
        )
      }
    )
  })
}

function toPostHogFlagProperties(
  flags?: AgentFeatureFlags
): PostHogSafeProperties {
  if (!flags) {
    return {}
  }

  const flagValues: Record<IntegrationFlagKey, boolean> = {
    "agent.knowledge_search.enabled": flags.knowledgeSearchEnabled,
    "agent.async_reports.enabled": flags.asyncReportsEnabled,
    "agent.telemetry.record_io": flags.telemetryRecordIo,
    "agent.finance_workflows.enabled": flags.financeWorkflowsEnabled,
    [POSTHOG_ANALYTICS_FLAG_KEY]: true,
  }
  const properties: PostHogSafeProperties = {}
  const activeFlags: string[] = []

  for (const [flagKey, value] of Object.entries(flagValues) as [
    IntegrationFlagKey,
    boolean,
  ][]) {
    const slug = toVercelFlagSlug(flagKey)
    properties[`$feature/${slug}`] = value
    if (value) {
      activeFlags.push(slug)
    }
  }

  properties.$active_feature_flags = activeFlags
  return properties
}

export function toPostHogSizeBucket(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "unknown"
  }

  if (sizeBytes < 10 * 1024) {
    return "lt_10kb"
  }

  if (sizeBytes < 100 * 1024) {
    return "lt_100kb"
  }

  if (sizeBytes < 1024 * 1024) {
    return "lt_1mb"
  }

  if (sizeBytes < 5 * 1024 * 1024) {
    return "lt_5mb"
  }

  return "gte_5mb"
}

export async function capturePostHogProductEvent({
  event,
  featureFlags,
  properties,
  requestId,
  userEmail,
  userId,
}: {
  event: PostHogProductEventName
  featureFlags?: AgentFeatureFlags
  properties?: Record<string, unknown>
  requestId?: string
  userEmail?: string | null
  userId: string
}): Promise<void> {
  if (!(await isPostHogAnalyticsEnabled({ userEmail }))) {
    return
  }

  const token = resolvePostHogProjectToken()
  if (!token) {
    return
  }

  try {
    const { PostHog } = await import("posthog-node")
    const client = new PostHog(token, {
      flushAt: 1,
      flushInterval: 0,
      host: resolvePostHogHost(),
    })
    const safeProperties = scrubPostHogProperties({
      ...(properties ?? {}),
      ...toPostHogFlagProperties(featureFlags),
      ...(requestId ? { request_id: requestId } : {}),
      $process_person_profile: false,
      app: "chloei",
      runtime: "server",
    })

    client.capture({
      distinctId: hashPrivacyValue(userId, "user"),
      event,
      properties: safeProperties,
      disableGeoip: true,
    })
    await withTimeout(
      client.shutdown(POSTHOG_CAPTURE_TIMEOUT_MS),
      POSTHOG_CAPTURE_TIMEOUT_MS
    )
  } catch (error) {
    logger.warn("PostHog product analytics capture failed.", {
      error,
      event,
      requestId,
    })
  }
}
