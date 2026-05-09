const SENSITIVE_FIELD_PATTERN =
  /(password|passcode|secret|token|authorization|cookie|session|api[_-]?key|credential|ssn|tax[_-]?id|account[_-]?number|routing[_-]?number|card|prompt|completion|attachment|dataurl|email|ip[_-]?address)/i

const MAX_STRING_LENGTH = 2_000

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value
  }

  if (!value || typeof value !== "object") {
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(scrubValue)
  }

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    output[key] = SENSITIVE_FIELD_PATTERN.test(key)
      ? "[Filtered]"
      : scrubValue(nestedValue)
  }

  return output
}

export function scrubSentryEvent<T>(event: T): T | null {
  return scrubValue(event) as T
}
