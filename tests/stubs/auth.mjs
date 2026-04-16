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

  return Response.json(
    { error: "Auth unavailable." },
    {
      status: 503,
      headers,
    }
  )
}
