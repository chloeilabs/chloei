export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  return value as Record<string, unknown>
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/** Trim a value to a non-empty string, or `undefined` when blank/non-string. */
export function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError"
  }

  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError"
  }

  return false
}
