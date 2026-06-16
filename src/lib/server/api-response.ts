interface CreateApiHeadersParams {
  headers?: HeadersInit
  requestId: string
}

interface CreateApiErrorResponseParams extends CreateApiHeadersParams {
  error: string
  errorCode: string
  status: number
}

interface ApiErrorResponseBody {
  error: string
  errorCode: string
  requestId: string
}

export function createApiHeaders(params: CreateApiHeadersParams): Headers {
  const responseHeaders = new Headers(params.headers)
  responseHeaders.set("Cache-Control", "no-store")
  responseHeaders.set("X-Content-Type-Options", "nosniff")
  responseHeaders.set("X-Request-Id", params.requestId)

  return responseHeaders
}

export function createApiErrorBody(
  params: Pick<
    CreateApiErrorResponseParams,
    "error" | "errorCode" | "requestId"
  >
): ApiErrorResponseBody {
  return {
    error: params.error,
    errorCode: params.errorCode,
    requestId: params.requestId,
  }
}

export function createApiErrorResponse(params: CreateApiErrorResponseParams) {
  const responseHeaders = createApiHeaders({
    headers: params.headers,
    requestId: params.requestId,
  })
  responseHeaders.set("X-Error-Code", params.errorCode)

  return Response.json(createApiErrorBody(params), {
    status: params.status,
    headers: responseHeaders,
  })
}

/**
 * Positional convenience wrapper around {@link createApiErrorResponse} used by
 * route handlers for terse error returns. The optional `headers` argument
 * forwards extra response headers.
 */
export function createErrorResponse(
  requestId: string,
  error: string,
  errorCode: string,
  status: number,
  headers?: HeadersInit
) {
  return createApiErrorResponse({
    headers,
    requestId,
    error,
    errorCode,
    status,
  })
}
