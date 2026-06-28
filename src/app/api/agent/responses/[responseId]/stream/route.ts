import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import { createApiHeaders } from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { getOpenAiApiKey } from "@/lib/server/env"
import { resumeBackgroundResponseStream } from "@/lib/server/llm/background-responses"
import { getOpenAiClient } from "@/lib/server/llm/openai-raw-client"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"
export const maxDuration = 800

/**
 * Resumes streaming a stored (background) response as NDJSON AgentStreamEvents,
 * starting after the `?after=<sequenceNumber>` checkpoint so a dropped
 * connection can reconnect without losing or repeating output. Pairs with
 * `createBackgroundResponse`; the worker that creates background agent runs is
 * the remaining piece (see background-responses.ts).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ responseId: string }> }
) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`agent-resume:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/agent/responses/[responseId]/stream",
  })
  const headers = createApiHeaders({ requestId })

  if (!isAuthConfigured()) {
    return observeRouteResponse(
      observation,
      createAuthUnavailableResponse(headers),
      { errorCode: "AUTH_UNAVAILABLE", outcome: "auth_unavailable" }
    )
  }

  const session = await getRequestSession(request.headers)
  if (!session) {
    return observeRouteResponse(
      observation,
      new Response(null, { status: 401, headers }),
      { errorCode: "AGENT_UNAUTHORIZED", outcome: "unauthorized" }
    )
  }

  const apiKey = getOpenAiApiKey()
  if (!apiKey) {
    return observeRouteResponse(
      observation,
      new Response(null, { status: 500, headers }),
      { errorCode: "AGENT_OPENAI_API_KEY_MISSING", outcome: "error" }
    )
  }

  const { responseId } = await params
  const afterRaw = request.nextUrl.searchParams.get("after")
  const startingAfter =
    afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : undefined

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of resumeBackgroundResponseStream(
          getOpenAiClient(apiKey),
          responseId,
          startingAfter
        )) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
      } catch (error) {
        logger.error("Failed to resume background response stream.", {
          error,
          errorCode: "AGENT_RESUME_FAILED",
          requestId,
        })
        try {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "agent_status", status: "failed" })}\n`
            )
          )
        } catch {}
      } finally {
        try {
          controller.close()
        } catch {}
      }
    },
  })

  const responseHeaders = createApiHeaders({ requestId })
  responseHeaders.set("Content-Type", "application/x-ndjson; charset=utf-8")
  responseHeaders.set("Cache-Control", "no-store, no-transform")

  return observeRouteResponse(
    observation,
    new Response(stream, { headers: responseHeaders }),
    { outcome: "stream_started" }
  )
}
