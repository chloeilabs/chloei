const SENSITIVE_FIELD_PATTERN =
  /(password|passcode|secret|token|authorization|cookie|session|api[_-]?key|credential|ssn|tax[_-]?id|account[_-]?number|routing[_-]?number|card|prompt|completion|content|message|attachment|filename|path|pathname|url|dataurl|email|name)/i

const MAX_STRING_LENGTH = 500
const MAX_ARRAY_LENGTH = 25
const SAFE_PROPERTY_KEYS = new Set([
  "$active_feature_flags",
  "app",
  "attachment_count",
  "attachment_kind",
  "content_type",
  "financial_services_workflow",
  "has_thread",
  "message_count",
  "model_id",
  "prompt_task_mode",
  "provider",
  "request_id",
  "run_mode",
  "runtime",
  "runtime_profile",
  "size_bucket",
  "title_present",
])

type JsonPrimitive = string | number | boolean | null
export type PostHogSafeProperties = Record<
  string,
  JsonPrimitive | JsonPrimitive[] | Record<string, JsonPrimitive>
>

function isAllowedReservedProperty(key: string): boolean {
  return key === "$process_person_profile" || key.startsWith("$feature/")
}

function isAllowedSafeProperty(key: string): boolean {
  return isAllowedReservedProperty(key) || SAFE_PROPERTY_KEYS.has(key)
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value
  }

  if (value === null || typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(scrubValue)
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    output[key] =
      SENSITIVE_FIELD_PATTERN.test(key) && !isAllowedSafeProperty(key)
        ? "[Filtered]"
        : scrubValue(nestedValue)
  }

  return output
}

export function scrubPostHogProperties(
  properties: Record<string, unknown>
): PostHogSafeProperties {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (isAllowedSafeProperty(key)) {
      output[key] = scrubValue(value)
      continue
    }

    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      output[key] = "[Filtered]"
    }
  }

  return output as PostHogSafeProperties
}

export function scrubPostHogEvent<T>(event: T): T {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return scrubValue(event) as T
  }

  const scrubbed = scrubValue(event)
  if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) {
    return scrubbed as T
  }

  const output = scrubbed as Record<string, unknown>
  const properties = (event as Record<string, unknown>).properties
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    output.properties = scrubPostHogProperties(
      properties as Record<string, unknown>
    )
  }

  return output as T
}
