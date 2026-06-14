import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiHeaders,
  createErrorResponse,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { getAgentJobForUser } from "@/lib/server/jobs"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

interface JobRouteContext {
  params: Promise<{
    jobId: string
  }>
}

export async function GET(request: NextRequest, context: JobRouteContext) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`jobs:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/jobs/[jobId]",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse(createApiHeaders({ requestId })),
        {
          errorCode: "AUTH_UNAVAILABLE",
          outcome: "auth_unavailable",
        }
      )
    }

    const session = await getRequestSession(request.headers)
    if (!session) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Unauthorized.",
          "JOB_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "JOB_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const params = await context.params
    const job = await getAgentJobForUser({
      userId: session.user.id,
      jobId: params.jobId,
    })
    if (!job) {
      return observeRouteResponse(
        observation,
        createErrorResponse(requestId, "Job not found.", "JOB_NOT_FOUND", 404),
        {
          errorCode: "JOB_NOT_FOUND",
          outcome: "not_found",
        }
      )
    }

    return observeRouteResponse(
      observation,
      Response.json({ job }, { headers: createApiHeaders({ requestId }) }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    logger.error("Job status request failed.", {
      error,
      errorCode: "JOB_STATUS_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Job status request failed.",
        "JOB_STATUS_FAILED",
        500
      ),
      {
        errorCode: "JOB_STATUS_FAILED",
        outcome: "error",
      }
    )
  }
}
