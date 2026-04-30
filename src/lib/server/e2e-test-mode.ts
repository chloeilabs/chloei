import { createApiHeaders } from "./api-response"

const E2E_AUTH_COOKIE_NAME = "chloei_e2e_auth"
const E2E_AUTH_COOKIE_VALUE = "1"

export const E2E_MOCK_VIEWER = {
  id: "e2e-user",
  name: "E2E User",
  email: "e2e@example.com",
} as const

export function isE2eMockModeEnabled(): boolean {
  if (process.env.E2E_MOCK_AUTH !== "1") {
    return false
  }

  if (process.env.VERCEL_ENV === "production") {
    return false
  }

  if (process.env.NODE_ENV !== "production") {
    return true
  }

  return (
    process.env.CI === "true" ||
    process.env.E2E_MOCK_AUTH_ALLOW_NEXT_START === "1"
  )
}

export function getE2eAuthCookie() {
  return {
    name: E2E_AUTH_COOKIE_NAME,
    value: E2E_AUTH_COOKIE_VALUE,
  } as const
}

export function isE2eAuthenticatedRequest(headers: Headers): boolean {
  if (!isE2eMockModeEnabled()) {
    return false
  }

  const cookieHeader = headers.get("cookie") ?? ""
  return cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .some((cookie) => cookie === `${E2E_AUTH_COOKIE_NAME}=1`)
}

export function createE2eAgentStreamResponse({
  requestId,
}: {
  requestId: string
}) {
  const encoder = new TextEncoder()
  const configuredResponseText = process.env.E2E_MOCK_AGENT_RESPONSE?.trim()
  const responseText =
    configuredResponseText && configuredResponseText.length > 0
      ? configuredResponseText
      : "SMOKE_OK"

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of [
        { type: "agent_status", status: "in_progress" },
        { type: "text_delta", delta: responseText },
        { type: "agent_status", status: "completed" },
      ]) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      controller.close()
    },
  })

  const headers = createApiHeaders({ requestId })
  headers.set("Content-Type", "application/x-ndjson; charset=utf-8")
  headers.set("Cache-Control", "no-store, no-transform")

  return new Response(stream, {
    headers,
  })
}
