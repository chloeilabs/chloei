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
import {
  getGoblinsRunForUser,
  isGoblinsRunTerminal,
} from "@/lib/server/goblins-run-store"
import { failGoblinsRun } from "@/lib/server/llm/goblins-background-run"
import { getOpenAiClient } from "@/lib/server/llm/openai-raw-client"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

/**
 * Cancels a durable background Goblins run: best-effort cancel of the
 * in-flight OpenAI response, then marks the run cancelled. Idempotent — a
 * second cancel (or cancelling a finished run) reports the current status.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`goblins-run-cancel:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/agent/goblins-runs/[runId]/cancel",
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

  const { runId } = await params
  const run = await getGoblinsRunForUser(session.user.id, runId)
  if (!run) {
    return observeRouteResponse(
      observation,
      new Response(null, { status: 404, headers }),
      { errorCode: "GOBLINS_RUN_NOT_FOUND", outcome: "not_found" }
    )
  }

  if (!isGoblinsRunTerminal(run.status)) {
    const apiKey = getOpenAiApiKey()
    if (apiKey && run.openaiResponseId) {
      await getOpenAiClient(apiKey)
        .responses.cancel(run.openaiResponseId)
        .catch((error: unknown) => {
          logger.warn("OpenAI response cancel failed; run still cancelled.", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
    await failGoblinsRun(runId, "cancelled")
  }

  return observeRouteResponse(
    observation,
    Response.json(
      {
        runId: run.id,
        status: isGoblinsRunTerminal(run.status) ? run.status : "cancelled",
      },
      { headers }
    ),
    { outcome: "success" }
  )
}
