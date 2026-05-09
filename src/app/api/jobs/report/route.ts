import { randomUUID } from "node:crypto"

import { type NextRequest } from "next/server"
import { z } from "zod"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { inngest } from "@/lib/server/inngest/client"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"
import { createAgentJob, updateAgentJobStatus } from "@/lib/server/jobs"
import { capturePostHogProductEvent } from "@/lib/server/posthog-analytics"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

const reportRequestSchema = z.object({
  reportId: z.uuid().optional(),
  threadId: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(200).optional(),
})

function createErrorResponse(
  requestId: string,
  error: string,
  errorCode: string,
  status: number
) {
  return createApiErrorResponse({
    requestId,
    error,
    errorCode,
    status,
  })
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`jobs-report:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/jobs/report",
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
          "JOB_REPORT_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "JOB_REPORT_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const flags = await resolveAgentFeatureFlags({
      userEmail: session.user.email,
    })
    if (!flags.asyncReportsEnabled) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Async reports are disabled.",
          "JOB_REPORT_DISABLED",
          403
        ),
        {
          errorCode: "JOB_REPORT_DISABLED",
          outcome: "forbidden",
        }
      )
    }

    const parsed = reportRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid report request.",
          "JOB_REPORT_INVALID_REQUEST",
          400
        ),
        {
          errorCode: "JOB_REPORT_INVALID_REQUEST",
          outcome: "invalid_request",
        }
      )
    }

    const reportId = parsed.data.reportId ?? randomUUID()
    const reportPayload = {
      ...parsed.data,
      reportId,
    }
    const idempotencyKey = [
      "report",
      session.user.id,
      parsed.data.threadId ?? "adhoc",
      reportId,
    ].join(":")
    const job = await createAgentJob({
      userId: session.user.id,
      type: "agent/report.requested",
      payload: reportPayload,
      idempotencyKey,
    })

    await inngest
      .send({
        id: `agent/report.requested:${session.user.id}:${job.id}`,
        name: "agent/report.requested",
        data: {
          userId: session.user.id,
          jobId: job.id,
          ...reportPayload,
        },
      })
      .catch(async (error: unknown) => {
        logger.error("Report job enqueue failed.", {
          error,
          errorCode: "JOB_REPORT_ENQUEUE_FAILED",
          requestId,
        })
        await updateAgentJobStatus({
          jobId: job.id,
          status: "failed",
          error: "Report job could not be enqueued.",
        })
      })

    await capturePostHogProductEvent({
      event: "async_report_requested",
      featureFlags: flags,
      requestId,
      userEmail: session.user.email,
      userId: session.user.id,
      properties: {
        has_thread: Boolean(parsed.data.threadId),
        title_present: Boolean(parsed.data.title),
      },
    })

    return observeRouteResponse(
      observation,
      Response.json(
        {
          jobId: job.id,
          reportId,
          status: job.status,
        },
        {
          status: 202,
          headers: createApiHeaders({ requestId }),
        }
      ),
      {
        outcome: "accepted",
      }
    )
  } catch (error) {
    logger.error("Report job request failed.", {
      error,
      errorCode: "JOB_REPORT_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Report job request failed.",
        "JOB_REPORT_FAILED",
        500
      ),
      {
        errorCode: "JOB_REPORT_FAILED",
        outcome: "error",
      }
    )
  }
}
