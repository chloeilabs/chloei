import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import { continueCloudAgentTaskAfterApproval } from "@/lib/server/cloud-agents"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`cloud-agent-dev-approve:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/internal-dev/cloud-agents/approve",
  })

  if (
    process.env.NODE_ENV === "production" ||
    process.env.CLOUD_AGENT_DEV_BYPASS !== "1"
  ) {
    return observeRouteResponse(
      observation,
      createApiErrorResponse({
        requestId,
        error: "Not found.",
        errorCode: "CLOUD_AGENT_DEV_BYPASS_DISABLED",
        status: 404,
      }),
      { errorCode: "CLOUD_AGENT_DEV_BYPASS_DISABLED", outcome: "not_found" }
    )
  }

  let body: { userId?: string; taskId?: string; approved?: boolean }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return observeRouteResponse(
      observation,
      createApiErrorResponse({
        requestId,
        error: "Invalid JSON body.",
        errorCode: "CLOUD_AGENT_DEV_BYPASS_INVALID",
        status: 400,
      }),
      {
        errorCode: "CLOUD_AGENT_DEV_BYPASS_INVALID",
        outcome: "invalid_request",
      }
    )
  }

  if (!body.userId || !body.taskId) {
    return observeRouteResponse(
      observation,
      createApiErrorResponse({
        requestId,
        error: "userId and taskId are required.",
        errorCode: "CLOUD_AGENT_DEV_BYPASS_INVALID",
        status: 400,
      }),
      {
        errorCode: "CLOUD_AGENT_DEV_BYPASS_INVALID",
        outcome: "invalid_request",
      }
    )
  }

  const userId = body.userId
  const taskId = body.taskId
  const approved = body.approved !== false
  // Fire-and-forget; runtime drives the post-approval flow in-process.
  void continueCloudAgentTaskAfterApproval({ userId, taskId, approved }).catch(
    (error: unknown) => {
      logger.error("Cloud agent dev approval continuation failed.", {
        error,
        errorCode: "CLOUD_AGENT_DEV_BYPASS_CONTINUATION_FAILED",
        requestId,
        taskId,
        userId,
      })
    }
  )
  return observeRouteResponse(
    observation,
    Response.json(
      { accepted: true },
      { status: 202, headers: createApiHeaders({ requestId }) }
    ),
    { outcome: "accepted" }
  )
}
