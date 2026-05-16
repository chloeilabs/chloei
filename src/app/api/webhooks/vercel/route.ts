import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import {
  appendCloudAgentTaskEvent,
  findCloudAgentTaskAnyUserById,
  findCloudAgentTaskAnyUserByProjectAndBranch,
  parseVercelWebhookEvent,
  updateCloudAgentTask,
  verifyVercelWebhookSignature,
} from "@/lib/server/cloud-agents"
import { resolveIntegrationBooleanFlag } from "@/lib/server/integration-flags"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

function errorResponse(
  requestId: string,
  error: string,
  errorCode: string,
  status: number
) {
  return createApiErrorResponse({ requestId, error, errorCode, status })
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`webhook-vercel:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/webhooks/vercel",
  })

  try {
    const enabled = await resolveIntegrationBooleanFlag({
      key: "agent.cloud_agents.vercel_deployments.enabled",
      envNames: [
        "AGENT_CLOUD_AGENTS_VERCEL_DEPLOYMENTS_ENABLED",
        "AGENT_CLOUD_AGENTS_ENABLED",
      ],
      defaultValue: false,
    })
    if (!enabled) {
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "Vercel cloud agent webhook disabled.",
          "CLOUD_AGENT_VERCEL_WEBHOOK_DISABLED",
          403
        ),
        {
          errorCode: "CLOUD_AGENT_VERCEL_WEBHOOK_DISABLED",
          outcome: "forbidden",
        }
      )
    }

    const secret = process.env.VERCEL_WEBHOOK_SECRET
    if (!secret) {
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "Vercel webhook secret is not configured.",
          "CLOUD_AGENT_VERCEL_WEBHOOK_UNCONFIGURED",
          500
        ),
        {
          errorCode: "CLOUD_AGENT_VERCEL_WEBHOOK_UNCONFIGURED",
          outcome: "error",
        }
      )
    }

    const payload = await request.text()
    const verification = verifyVercelWebhookSignature({
      payload,
      signatureHeader: request.headers.get("x-vercel-signature"),
      secret,
    })
    if (!verification.ok) {
      logger.warn("Vercel webhook signature rejected.", {
        reason: verification.reason,
        requestId,
      })
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "Invalid Vercel webhook signature.",
          "CLOUD_AGENT_VERCEL_WEBHOOK_SIGNATURE_INVALID",
          401
        ),
        {
          errorCode: "CLOUD_AGENT_VERCEL_WEBHOOK_SIGNATURE_INVALID",
          outcome: "unauthorized",
        }
      )
    }

    const parsed = parseVercelWebhookEvent(JSON.parse(payload) as unknown)
    if (parsed.type === "ignored") {
      return observeRouteResponse(
        observation,
        Response.json(
          { accepted: false, reason: parsed.reason },
          { status: 200, headers: createApiHeaders({ requestId }) }
        ),
        { outcome: "ignored" }
      )
    }

    // The Vercel webhook is HMAC-signed and carries no per-user auth, so
    // lookup the owning task across all users — both automation- and
    // dashboard-created tasks need their previewUrl populated. We require
    // either an explicit chloei_task_id (set as deployment meta) or a
    // (vercelProjectId, branch) pair so two unrelated environments that
    // happen to share a branch name (e.g. `main`) never trample each
    // other's previewUrl.
    const match =
      (parsed.taskId
        ? await findCloudAgentTaskAnyUserById(parsed.taskId)
        : null) ??
      (parsed.branch && parsed.projectId
        ? await findCloudAgentTaskAnyUserByProjectAndBranch({
            branch: parsed.branch,
            vercelProjectId: parsed.projectId,
          })
        : null)
    if (!match) {
      return observeRouteResponse(
        observation,
        Response.json(
          {
            accepted: false,
            reason:
              "No matching cloud agent task found via chloei_task_id metadata or branch.",
          },
          { status: 200, headers: createApiHeaders({ requestId }) }
        ),
        { outcome: "ignored" }
      )
    }
    const { userId, task } = match

    await updateCloudAgentTask(userId, task.id, {
      previewUrl: parsed.url,
    })
    await appendCloudAgentTaskEvent({
      userId,
      taskId: task.id,
      payload: {
        kind: "preview_ready",
        url: parsed.url,
        environment: parsed.target,
      },
    })

    return observeRouteResponse(
      observation,
      Response.json(
        { accepted: true, taskId: task.id, previewUrl: parsed.url },
        { status: 202, headers: createApiHeaders({ requestId }) }
      ),
      { outcome: "accepted" }
    )
  } catch (error) {
    logger.error("Vercel webhook handling failed.", {
      error,
      errorCode: "CLOUD_AGENT_VERCEL_WEBHOOK_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      errorResponse(
        requestId,
        "Vercel webhook handling failed.",
        "CLOUD_AGENT_VERCEL_WEBHOOK_FAILED",
        500
      ),
      { errorCode: "CLOUD_AGENT_VERCEL_WEBHOOK_FAILED", outcome: "error" }
    )
  }
}
