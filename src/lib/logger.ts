type LogLevel = "warn" | "error"

function emitLog(
  level: LogLevel,
  scope: string,
  message: string,
  details?: unknown
) {
  const formattedMessage = `[${scope}] ${message}`

  if (level === "warn") {
    if (details === undefined) {
      console.warn(formattedMessage)
      return
    }

    console.warn(formattedMessage, details)
    return
  }

  if (details === undefined) {
    console.error(formattedMessage)
    return
  }

  console.error(formattedMessage, details)
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
