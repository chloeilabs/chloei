type LogLevel = "info" | "warn" | "error"

interface StructuredLogEntry {
  commitSha?: string
  details?: unknown
  durationMs?: number
  deploymentEnv?: string
  deploymentId?: string
  deploymentRegion?: string
  deploymentTargetEnv?: string
  errorCode?: string
  level: LogLevel
  message: string
  method?: string
  model?: string
  outcome?: string
  projectId?: string
  requestId?: string
  route?: string
  scope: string
  status?: number
  timestamp: string
}

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

    if ("errorCode" in error && error.errorCode !== undefined) {
      normalizedError.errorCode = error.errorCode
    }

    if ("requestId" in error && error.requestId !== undefined) {
      normalizedError.requestId = error.requestId
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

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim()
  if (trimmedValue === undefined || trimmedValue === "") {
    return undefined
  }

  return trimmedValue
}

function resolveDeploymentMetadata() {
  if (typeof window !== "undefined") {
    return undefined
  }

  const deploymentEnv = normalizeEnvValue(process.env.VERCEL_ENV)
  const deploymentTargetEnv = normalizeEnvValue(process.env.VERCEL_TARGET_ENV)
  const deploymentRegion = normalizeEnvValue(process.env.VERCEL_REGION)
  const deploymentId = normalizeEnvValue(process.env.VERCEL_DEPLOYMENT_ID)
  const projectId = normalizeEnvValue(process.env.VERCEL_PROJECT_ID)
  const commitSha = normalizeEnvValue(process.env.VERCEL_GIT_COMMIT_SHA)

  if (
    deploymentEnv === undefined &&
    deploymentTargetEnv === undefined &&
    deploymentRegion === undefined &&
    deploymentId === undefined &&
    projectId === undefined &&
    commitSha === undefined
  ) {
    return undefined
  }

  return {
    ...(commitSha ? { commitSha } : {}),
    ...(deploymentEnv ? { deploymentEnv } : {}),
    ...(deploymentId ? { deploymentId } : {}),
    ...(deploymentRegion ? { deploymentRegion } : {}),
    ...(deploymentTargetEnv ? { deploymentTargetEnv } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

function isServerProductionLoggerEnabled(): boolean {
  if (typeof window !== "undefined") {
    return false
  }

  const logFormat = process.env.LOG_FORMAT?.trim().toLowerCase()
  if (logFormat === "json") {
    return true
  }

  return process.env.NODE_ENV === "production"
}

function createStructuredLogEntry(
  level: LogLevel,
  scope: string,
  message: string,
  details?: unknown
): StructuredLogEntry {
  const entry: StructuredLogEntry = {
    level,
    message,
    scope,
    timestamp: new Date().toISOString(),
  }
  const deploymentMetadata = resolveDeploymentMetadata()

  if (deploymentMetadata) {
    Object.assign(entry, deploymentMetadata)
  }

  if (!isRecord(details)) {
    if (details !== undefined) {
      entry.details = details
    }

    return entry
  }

  if (typeof details.requestId === "string") {
    entry.requestId = details.requestId
  }

  if (typeof details.errorCode === "string") {
    entry.errorCode = details.errorCode
  }

  if (typeof details.durationMs === "number") {
    entry.durationMs = details.durationMs
  }

  if (typeof details.method === "string") {
    entry.method = details.method
  }

  if (typeof details.model === "string") {
    entry.model = details.model
  }

  if (typeof details.outcome === "string") {
    entry.outcome = details.outcome
  }

  if (typeof details.route === "string") {
    entry.route = details.route
  }

  if (typeof details.status === "number") {
    entry.status = details.status
  }

  entry.details = details
  return entry
}

function serializeLogLine(payload: unknown): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return JSON.stringify({
      message: "Failed to serialize log payload.",
    })
  }
}

function writeInfoLine(payload: string) {
  if (typeof window !== "undefined") {
    window.console.info(payload)
    return
  }

  if (typeof process !== "undefined" && typeof process.stdout.write === "function") {
    process.stdout.write(`${payload}\n`)
    return
  }

  console.warn(payload)
}

function emitStructuredLog(
  level: LogLevel,
  scope: string,
  message: string,
  details?: unknown
) {
  const entry = createStructuredLogEntry(level, scope, message, details)
  const serializedEntry = serializeLogLine(entry)

  if (level === "info") {
    writeInfoLine(serializedEntry)
    return
  }

  if (level === "warn") {
    console.warn(serializedEntry)
    return
  }

  console.error(serializedEntry)
}

function emitLog(
  level: LogLevel,
  scope: string,
  message: string,
  details?: unknown
) {
  const normalizedDetails = normalizeLogDetails(details)

  if (isServerProductionLoggerEnabled()) {
    try {
      emitStructuredLog(level, scope, message, normalizedDetails)
      return
    } catch {
      // Fall back to the human-readable console format if serialization fails.
    }
  }

  const formattedMessage = `[${scope}] ${message}`

  if (level === "info") {
    if (normalizedDetails === undefined) {
      writeInfoLine(formattedMessage)
      return
    }

    writeInfoLine(
      `${formattedMessage} ${serializeLogLine(normalizedDetails)}`
    )
    return
  }

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
    info(message: string, details?: unknown) {
      emitLog("info", scope, message, details)
    },
    warn(message: string, details?: unknown) {
      emitLog("warn", scope, message, details)
    },
    error(message: string, details?: unknown) {
      emitLog("error", scope, message, details)
    },
  }
}
