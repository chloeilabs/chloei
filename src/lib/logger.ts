type LogLevel = "warn" | "error"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const normalizedError: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    }

    if (error.stack) {
      normalizedError.stack = error.stack
    }

    if ("code" in error && error.code !== undefined) {
      normalizedError.code = error.code
    }

    if ("status" in error && error.status !== undefined) {
      normalizedError.status = error.status
    }

    if ("statusCode" in error && error.statusCode !== undefined) {
      normalizedError.statusCode = error.statusCode
    }

    if ("cause" in error && error.cause !== undefined) {
      normalizedError.cause =
        error.cause instanceof Error
          ? normalizeError(error.cause)
          : error.cause
    }

    return normalizedError
  }

  if (isRecord(error)) {
    return Object.fromEntries(
      Object.entries(error).map(([key, value]) => [
        key,
        value instanceof Error ? normalizeError(value) : value,
      ])
    )
  }

  return { value: error }
}

function normalizeLogDetails(details: unknown): unknown {
  if (details === undefined) {
    return undefined
  }

  if (details instanceof Error) {
    return { error: normalizeError(details) }
  }

  if (isRecord(details)) {
    return Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        key,
        value instanceof Error ? normalizeError(value) : value,
      ])
    )
  }

  return { value: details }
}

function emitLog(
  level: LogLevel,
  scope: string,
  message: string,
  details?: unknown
) {
  const formattedMessage = `[${scope}] ${message}`
  const normalizedDetails = normalizeLogDetails(details)

  if (level === "warn") {
    if (normalizedDetails === undefined) {
      console.warn(formattedMessage)
      return
    }

    console.warn(formattedMessage, normalizedDetails)
    return
  }

  if (normalizedDetails === undefined) {
    console.error(formattedMessage)
    return
  }

  console.error(formattedMessage, normalizedDetails)
}

export function createLogger(scope: string) {
  return {
    warn(message: string, details?: unknown) {
      emitLog("warn", scope, message, details)
    },
    error(message: string, details?: unknown) {
      emitLog("error", scope, message, details)
    },
  }
}
