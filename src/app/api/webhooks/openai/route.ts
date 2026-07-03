import { after, type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import { createApiHeaders } from "@/lib/server/api-response"
import { getOpenAiApiKey, getOpenAiWebhookSecret } from "@/lib/server/env"
import { getGoblinsRunByResponseId } from "@/lib/server/goblins-run-store"
import {
  continueGoblinsRun,
  failGoblinsRun,
} from "@/lib/server/llm/goblins-background-run"
import { getOpenAiClient } from "@/lib/server/llm/openai-raw-client"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"
export const maxDuration = 800

// Best-effort, per-instance idempotency: OpenAI retries deliveries, so we drop
// webhook ids we have already handled. A multi-instance deploy would back this
// with a shared store; for now this de-dupes within a warm instance.
const SEEN_WEBHOOK_IDS_LIMIT = 1000
const seenWebhookIds = new Set<string>()

function markWebhookSeen(id: string): boolean {
  if (seenWebhookIds.has(id)) {
    return false
  }
  if (seenWebhookIds.size >= SEEN_WEBHOOK_IDS_LIMIT) {
    const oldest = seenWebhookIds.values().next().value
    if (oldest !== undefined) {
      seenWebhookIds.delete(oldest)
    }
  }
  seenWebhookIds.add(id)
  return true
}

/**
 * Receiver for OpenAI webhook deliveries (Standard Webhooks). Verifies the
 * signature with the signing secret, de-dupes by webhook id, and handles
 * `response.completed` / `response.failed` (and friends). The signing secret is
 * the auth — there is no session here — so the route is intentionally public
 * (it is not matched by the middleware) and returns 2xx quickly.
 */
export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`webhooks-openai:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/webhooks/openai",
  })
  const headers = createApiHeaders({ requestId })

  const webhookSecret = getOpenAiWebhookSecret()
  const apiKey = getOpenAiApiKey()
  if (!webhookSecret || !apiKey) {
    return observeRouteResponse(
      observation,
      new Response(null, { status: 503, headers }),
      { errorCode: "WEBHOOK_NOT_CONFIGURED", outcome: "not_configured" }
    )
  }

  const rawBody = await request.text()

  let event
  try {
    // unwrap verifies the webhook-id/-timestamp/-signature headers and throws on
    // a bad signature or stale timestamp.
    event = await getOpenAiClient(apiKey).webhooks.unwrap(
      rawBody,
      request.headers,
      webhookSecret
    )
  } catch (error) {
    logger.warn("Rejected OpenAI webhook with an invalid signature.", {
      error,
      errorCode: "WEBHOOK_INVALID_SIGNATURE",
      requestId,
    })
    return observeRouteResponse(
      observation,
      new Response(null, { status: 400, headers }),
      { errorCode: "WEBHOOK_INVALID_SIGNATURE", outcome: "invalid_signature" }
    )
  }

  const eventId =
    typeof (event as { id?: unknown }).id === "string"
      ? (event as { id: string }).id
      : undefined
  if (eventId && !markWebhookSeen(eventId)) {
    // Duplicate delivery — already handled. Ack so OpenAI stops retrying.
    return observeRouteResponse(
      observation,
      new Response(null, { status: 200, headers }),
      { outcome: "duplicate" }
    )
  }

  const responseId =
    typeof (event as { data?: { id?: unknown } }).data?.id === "string"
      ? (event as { data: { id: string } }).data.id
      : undefined

  logger.info("Received OpenAI webhook.", {
    requestId,
    webhookId: eventId,
    webhookType: event.type,
    responseId,
  })

  // Background Goblins runs advance here: a terminal response delivery wakes
  // the continuation engine. Ack 2xx immediately and do the work via after();
  // the DB lease inside continueGoblinsRun makes duplicate/racing deliveries
  // safe, and unknown response ids stay acked no-ops (other products' events).
  if (
    responseId &&
    (event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.cancelled" ||
      event.type === "response.incomplete")
  ) {
    const webhookType = event.type
    after(async () => {
      try {
        const run = await getGoblinsRunByResponseId(responseId)
        if (!run) {
          return
        }
        if (webhookType === "response.completed") {
          await continueGoblinsRun(run.id, responseId)
        } else {
          await failGoblinsRun(
            run.id,
            webhookType === "response.cancelled" ? "cancelled" : "failed",
            webhookType
          )
        }
      } catch (error) {
        logger.error("Goblins webhook continuation failed.", {
          requestId,
          responseId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  return observeRouteResponse(
    observation,
    new Response(null, { status: 200, headers }),
    { outcome: "received" }
  )
}
