interface CreateApiHeadersParams {
  headers?: HeadersInit
  requestId: string
}

interface CreateApiErrorResponseParams extends CreateApiHeadersParams {
  error: string
  errorCode: string
  status: number
}

export interface ApiErrorResponseBody {
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
  params: Pick<CreateApiErrorResponseParams, "error" | "errorCode" | "requestId">
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
