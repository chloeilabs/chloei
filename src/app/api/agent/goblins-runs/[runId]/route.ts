import { after, type NextRequest } from "next/server"

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
import { continueGoblinsRun } from "@/lib/server/llm/goblins-background-run"
import { getOpenAiClient } from "@/lib/server/llm/openai-raw-client"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"
export const maxDuration = 800

// A run sitting in awaiting_manager without progress for this long triggers a
// poll-driven check of the OpenAI response — the recovery path for lost
// webhook deliveries.
const STALE_AWAITING_MANAGER_MS = 60_000

/**
 * Poll endpoint for a durable background Goblins run: returns the run status
 * plus the event-log slice after `?afterEvent=<n>` for client replay. Doubles
 * as the webhook-loss recovery wake source.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`goblins-run:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/agent/goblins-runs/[runId]",
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

  // Webhook-loss recovery: if the manager turn looks stale, check it directly
  // and drive the continuation from this invocation. The lease claim inside
  // continueGoblinsRun makes a race with a late webhook safe.
  const apiKey = getOpenAiApiKey()
  if (
    apiKey &&
    run.status === "awaiting_manager" &&
    run.openaiResponseId &&
    Date.now() - new Date(run.updatedAt).getTime() > STALE_AWAITING_MANAGER_MS
  ) {
    const responseId = run.openaiResponseId
    after(async () => {
      try {
        const response =
          await getOpenAiClient(apiKey).responses.retrieve(responseId)
        if (
          response.status === "completed" ||
          response.status === "failed" ||
          response.status === "cancelled"
        ) {
          logger.warn("Stale goblins run recovered by poll.", {
            runId,
            responseId,
            responseStatus: response.status,
          })
          await continueGoblinsRun(runId, responseId)
        }
      } catch (error) {
        logger.warn("Stale goblins run recovery failed.", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  const afterEventRaw = request.nextUrl.searchParams.get("afterEvent")
  const afterEvent =
    afterEventRaw !== null && /^\d+$/.test(afterEventRaw)
      ? Number(afterEventRaw)
      : 0

  const responseHeaders = createApiHeaders({ requestId })
  responseHeaders.set("Cache-Control", "no-store, no-transform")

  return observeRouteResponse(
    observation,
    Response.json(
      {
        runId: run.id,
        threadId: run.threadId,
        assistantMessageId: run.assistantMessageId,
        status: run.status,
        turn: run.phase.turn,
        openaiResponseId: run.openaiResponseId,
        eventCount: run.eventCount,
        events: run.events.slice(afterEvent),
        ...(run.error ? { error: run.error } : {}),
        terminal: isGoblinsRunTerminal(run.status),
      },
      { headers: responseHeaders }
    ),
    { outcome: "success" }
  )
}
