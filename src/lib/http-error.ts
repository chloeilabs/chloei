import { asRecord, asString } from "@/lib/cast"

export type HttpError = Error & {
  status?: number
  errorCode?: string
  requestId?: string
}

interface CreateHttpErrorParams {
  cause?: unknown
  errorCode?: string
  message: string
  requestId?: string
  status?: number
}

interface ParsedHttpErrorResponse {
  errorCode?: string
  message: string
  requestId?: string
  status: number
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmedValue = value?.trim()
  if (trimmedValue === undefined || trimmedValue === "") {
    return undefined
  }

  return trimmedValue
}

export function createHttpError(params: CreateHttpErrorParams): HttpError {
  const error = new Error(params.message) as HttpError

  if (typeof params.status === "number") {
    error.status = params.status
  }

  if (params.errorCode) {
    error.errorCode = params.errorCode
  }

  if (params.requestId) {
    error.requestId = params.requestId
  }

  if (params.cause !== undefined) {
    error.cause = params.cause
  }

  return error
}

export async function parseHttpErrorResponse(
  response: Response,
  fallbackMessage?: string
): Promise<ParsedHttpErrorResponse> {
  const bodyText = await response.text().catch(() => "")
  let message =
    normalizeOptionalString(fallbackMessage) ??
    `Request failed (${String(response.status)})`
  let errorCode = normalizeOptionalString(
    response.headers.get("X-Error-Code")
  )
  let requestId = normalizeOptionalString(
    response.headers.get("X-Request-Id")
  )

  if (bodyText) {
    try {
      const record = asRecord(JSON.parse(bodyText))
      const responseMessage = normalizeOptionalString(asString(record?.error))
      const responseErrorCode = normalizeOptionalString(
        asString(record?.errorCode)
      )
      const responseRequestId = normalizeOptionalString(
        asString(record?.requestId)
      )

      message = responseMessage ?? message
      errorCode = responseErrorCode ?? errorCode
      requestId = responseRequestId ?? requestId
    } catch {
      message = normalizeOptionalString(bodyText) ?? message
    }
  }

  return {
    message,
    errorCode,
    requestId,
    status: response.status,
  }
}

export async function createHttpErrorFromResponse(
  response: Response,
  fallbackMessage?: string
): Promise<HttpError> {
  return createHttpError(
    await parseHttpErrorResponse(response, fallbackMessage)
  )
}

export function getHttpErrorMessage(
  error: unknown,
  fallbackMessage = "Unknown error occurred"
): string {
  if (!(error instanceof Error)) {
    return fallbackMessage
  }

  const message = normalizeOptionalString(error.message)
  return message ?? fallbackMessage
}

export function getHttpErrorRequestId(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }

  return normalizeOptionalString((error as HttpError).requestId)
}

export function formatHttpErrorDescription(
  error: unknown,
  fallbackMessage = "Unknown error occurred"
): string {
  const message = getHttpErrorMessage(error, fallbackMessage)
  const requestId = getHttpErrorRequestId(error)

  if (!requestId) {
    return message
  }

  return `${message} Reference ID: ${requestId}`
}
