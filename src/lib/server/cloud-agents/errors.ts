const STORE_SETUP_MESSAGE =
  "Cloud agent storage is not initialized. Run `pnpm app:migrate` to initialize app tables."
const POSTGRES_UNDEFINED_TABLE_ERROR_CODE = "42P01"
const POSTGRES_UNDEFINED_COLUMN_ERROR_CODE = "42703"

export class CloudAgentStoreNotInitializedError extends Error {
  constructor() {
    super(STORE_SETUP_MESSAGE)
    this.name = "CloudAgentStoreNotInitializedError"
  }
}

export class CloudAgentNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`Cloud agent ${entity} ${id} not found.`)
    this.name = "CloudAgentNotFoundError"
  }
}

export class CloudAgentTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudAgentTransitionError"
  }
}

function isPostgresErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}

export function wrapCloudAgentStoreError(error: unknown): Error {
  if (
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_TABLE_ERROR_CODE) ||
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_COLUMN_ERROR_CODE)
  ) {
    return new CloudAgentStoreNotInitializedError()
  }

  return error instanceof Error
    ? error
    : new Error("Unknown cloud agent store error.")
}

export function isCloudAgentStoreNotInitializedError(
  error: unknown
): error is CloudAgentStoreNotInitializedError {
  return error instanceof CloudAgentStoreNotInitializedError
}

export function isCloudAgentNotFoundError(
  error: unknown
): error is CloudAgentNotFoundError {
  return error instanceof CloudAgentNotFoundError
}

export function isCloudAgentTransitionError(
  error: unknown
): error is CloudAgentTransitionError {
  return error instanceof CloudAgentTransitionError
}
