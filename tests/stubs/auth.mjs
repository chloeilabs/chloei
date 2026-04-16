import { getTestMocks } from "./mock-state.mjs"

export function isAuthConfigured() {
  return getTestMocks().auth?.isAuthConfigured?.() ?? true
}

export function createAuthUnavailableResponse(headers) {
  const customResponse =
    getTestMocks().auth?.createAuthUnavailableResponse?.(headers)
  if (customResponse) {
    return customResponse
  }

  const responseHeaders = new Headers(headers)
  const requestId =
    responseHeaders.get("X-Request-Id")?.trim() ?? "request-auth-unavailable"
  responseHeaders.set("X-Error-Code", "AUTH_UNAVAILABLE")
  responseHeaders.set("X-Request-Id", requestId)

  return Response.json(
    {
      error: "Auth unavailable.",
      errorCode: "AUTH_UNAVAILABLE",
      requestId,
    },
    {
      status: 503,
      headers: responseHeaders,
    }
  )
}
