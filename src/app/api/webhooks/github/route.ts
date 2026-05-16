import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import {
  parseGithubWebhookEvent,
  routeAutomationTriggerToCloudAgent,
  verifyGithubWebhookSignature,
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
  const logger = createLogger(`webhook-github:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/webhooks/github",
  })

  try {
    const enabled = await resolveIntegrationBooleanFlag({
      key: "agent.cloud_agents.github.enabled",
      envNames: [
        "AGENT_CLOUD_AGENTS_GITHUB_ENABLED",
        "AGENT_CLOUD_AGENTS_ENABLED",
      ],
      defaultValue: false,
    })
    if (!enabled) {
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "GitHub cloud agent webhook disabled.",
          "CLOUD_AGENT_GITHUB_WEBHOOK_DISABLED",
          403
        ),
        {
          errorCode: "CLOUD_AGENT_GITHUB_WEBHOOK_DISABLED",
          outcome: "forbidden",
        }
      )
    }

    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET
    if (!secret) {
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "GitHub webhook secret is not configured.",
          "CLOUD_AGENT_GITHUB_WEBHOOK_UNCONFIGURED",
          500
        ),
        {
          errorCode: "CLOUD_AGENT_GITHUB_WEBHOOK_UNCONFIGURED",
          outcome: "error",
        }
      )
    }

    const payload = await request.text()
    const signatureHeader = request.headers.get("x-hub-signature-256")
    const verification = verifyGithubWebhookSignature({
      payload,
      signatureHeader,
      secret,
    })
    if (!verification.ok) {
      logger.warn("GitHub webhook signature rejected.", {
        reason: verification.reason,
        requestId,
      })
      return observeRouteResponse(
        observation,
        errorResponse(
          requestId,
          "Invalid GitHub webhook signature.",
          "CLOUD_AGENT_GITHUB_WEBHOOK_SIGNATURE_INVALID",
          401
        ),
        {
          errorCode: "CLOUD_AGENT_GITHUB_WEBHOOK_SIGNATURE_INVALID",
          outcome: "unauthorized",
        }
      )
    }

    const eventHeader = request.headers.get("x-github-event") ?? "unknown"
    const parsed = parseGithubWebhookEvent({
      event: eventHeader,
      payload: JSON.parse(payload) as unknown,
    })
    if (parsed.type === "ignored") {
      return observeRouteResponse(
        observation,
        Response.json(
          { accepted: false, reason: parsed.reason },
          {
            status: 200,
            headers: createApiHeaders({ requestId }),
          }
        ),
        { outcome: "ignored" }
      )
    }

    if (parsed.type === "chloei_mention") {
      const prompt = `${parsed.action === "review" ? "Review" : "Fix"} requested via @chloei in ${parsed.repoOwner}/${parsed.repoName} #${String(parsed.issueNumber)} by @${parsed.requester}:\n\n${parsed.body}`
      const result = await routeAutomationTriggerToCloudAgent({
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        prompt,
        source: `github_${parsed.action}_mention`,
      })
      return observeRouteResponse(
        observation,
        Response.json(
          { accepted: true, dispatch: result },
          { status: 202, headers: createApiHeaders({ requestId }) }
        ),
        { outcome: "accepted" }
      )
    }

    if (parsed.type === "check_run_failed") {
      const prompt = `CI check '${parsed.checkName}' failed on ${parsed.repoOwner}/${parsed.repoName}@${parsed.headSha}. Investigate and propose a fix.${parsed.pullRequestNumbers.length > 0 ? ` PRs: ${parsed.pullRequestNumbers.map((n) => `#${String(n)}`).join(", ")}` : ""}`
      const result = await routeAutomationTriggerToCloudAgent({
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        prompt,
        source: "github_check_run_failed",
      })
      return observeRouteResponse(
        observation,
        Response.json(
          { accepted: true, dispatch: result },
          { status: 202, headers: createApiHeaders({ requestId }) }
        ),
        { outcome: "accepted" }
      )
    }

    return observeRouteResponse(
      observation,
      Response.json(
        { accepted: true, observed: parsed.type },
        { status: 200, headers: createApiHeaders({ requestId }) }
      ),
      { outcome: "observed" }
    )
  } catch (error) {
    logger.error("GitHub webhook handling failed.", {
      error,
      errorCode: "CLOUD_AGENT_GITHUB_WEBHOOK_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      errorResponse(
        requestId,
        "GitHub webhook handling failed.",
        "CLOUD_AGENT_GITHUB_WEBHOOK_FAILED",
        500
      ),
      { errorCode: "CLOUD_AGENT_GITHUB_WEBHOOK_FAILED", outcome: "error" }
    )
  }
}
