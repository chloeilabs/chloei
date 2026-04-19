function normalizeRequestId(
  value: string | null | undefined
): string | undefined {
  const trimmedValue = value?.trim()
  if (trimmedValue === undefined || trimmedValue === "") {
    return undefined
  }

  return trimmedValue
}

export function createRequestId(): string {
  return crypto.randomUUID()
}

export function getRequestIdFromHeaders(
  headers?: HeadersInit
): string | undefined {
  return normalizeRequestId(new Headers(headers).get("X-Request-Id"))
}

export function resolveRequestIdFromHeaders(headers?: HeadersInit): string {
  return getRequestIdFromHeaders(headers) ?? createRequestId()
}

export function createRequestHeaders(
  headers?: HeadersInit,
  requestId: string = createRequestId()
): Headers {
  const requestHeaders = new Headers(headers)
  requestHeaders.set("X-Request-Id", requestId)
  return requestHeaders
}
