import { randomUUID } from "node:crypto"

import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import {
  createJsonErrorResponse,
  resolveRequestId,
} from "@/lib/server/agent-route"
import {
  AGENT_RATE_LIMIT_ENABLED,
  AGENT_RATE_LIMIT_MAX_REQUESTS,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from "@/lib/server/agent-runtime-config"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { inngest } from "@/lib/server/inngest/client"
import { shouldRunInngestInlineFallback } from "@/lib/server/inngest/environment"
import { createAgentJob, updateAgentJobStatus } from "@/lib/server/jobs"
import { evaluateAndConsumeSlidingWindowRateLimit } from "@/lib/server/rate-limit"
import { TRADINGAGENTS_ENABLED } from "@/lib/server/trading-agents/config"
import { runTradingAnalysisJob } from "@/lib/server/trading-agents/jobs"
import { tradingDeskRequestSchema } from "@/lib/server/trading-agents/request-schema"
import type { TradingDeskRequest } from "@/lib/shared/trading-agents/types"

export const runtime = "nodejs"

/**
 * Kick off a Trading Desk analysis as a background job.
 *
 * For long deep-mode runs this decouples the analysis from the request: the
 * client gets a `jobId` immediately and polls `GET /api/jobs/{jobId}` for the
 * final result. When Inngest is configured the work runs there; otherwise the
 * inline fallback runs it in the background of the local server process.
 */
export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`trading-desk-job:${requestId}`)

  if (!isAuthConfigured()) {
    return createAuthUnavailableResponse({ "X-Request-Id": requestId })
  }

  const session = await getRequestSession(request.headers)
  if (!session) {
    return createJsonErrorResponse({
      requestId,
      error: "Unauthorized.",
      errorCode: "TRADING_DESK_JOB_UNAUTHORIZED",
      status: 401,
    })
  }

  if (!TRADINGAGENTS_ENABLED) {
    return createJsonErrorResponse({
      requestId,
      error: "Trading Desk is disabled.",
      errorCode: "TRADING_DESK_DISABLED",
      status: 503,
    })
  }

  const rateLimitDecision = AGENT_RATE_LIMIT_ENABLED
    ? await evaluateAndConsumeSlidingWindowRateLimit({
        identifier: `trading-desk-job:user:${session.user.id}`,
        maxRequests: AGENT_RATE_LIMIT_MAX_REQUESTS,
        windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
      })
    : null
  if (rateLimitDecision && !rateLimitDecision.allowed) {
    return createJsonErrorResponse({
      requestId,
      error: "Too many requests. Please retry shortly.",
      errorCode: "TRADING_DESK_JOB_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
      rateLimitDecision,
    })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createJsonErrorResponse({
      requestId,
      error: "Invalid JSON payload.",
      errorCode: "TRADING_DESK_JOB_INVALID_JSON",
      status: 400,
    })
  }

  const parsed = tradingDeskRequestSchema.safeParse(body)
  if (!parsed.success) {
    return createJsonErrorResponse({
      requestId,
      error: parsed.error.issues[0]?.message ?? "Invalid request.",
      errorCode: "TRADING_DESK_JOB_INVALID_REQUEST",
      status: 400,
    })
  }

  const analysisRequest: TradingDeskRequest = {
    ticker: parsed.data.ticker.toUpperCase(),
    tradeDate: parsed.data.tradeDate ?? null,
    analysts: parsed.data.analysts,
    depth: parsed.data.depth,
    assetType: parsed.data.assetType,
    online: parsed.data.online,
    mock: parsed.data.mock ?? null,
  }

  try {
    const runId = randomUUID()
    const job = await createAgentJob({
      userId: session.user.id,
      type: "trading/analysis.requested",
      payload: { request: analysisRequest, runId },
      idempotencyKey: ["trading", session.user.id, runId].join(":"),
    })

    if (shouldRunInngestInlineFallback()) {
      logger.warn("Running trading analysis through inline fallback.", {
        jobId: job.id,
        requestId,
      })
      // Fire-and-forget: return immediately and let the run finish in the
      // background of the local server process. The client polls for status.
      void runTradingAnalysisJob({ jobId: job.id, request: analysisRequest })
    } else {
      await inngest
        .send({
          id: `trading/analysis.requested:${session.user.id}:${job.id}`,
          name: "trading/analysis.requested",
          data: {
            userId: session.user.id,
            jobId: job.id,
            request: analysisRequest,
          },
        })
        .catch(async (error: unknown) => {
          logger.error("Trading analysis enqueue failed.", { error, requestId })
          await updateAgentJobStatus({
            jobId: job.id,
            status: "failed",
            error: "The analysis could not be enqueued.",
          }).catch(() => undefined)
        })
    }

    return Response.json(
      { jobId: job.id, status: "queued" },
      { status: 202, headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    logger.error("Trading analysis job request failed.", { error, requestId })
    return createJsonErrorResponse({
      requestId,
      error: "Failed to start the analysis job.",
      errorCode: "TRADING_DESK_JOB_FAILED",
      status: 500,
    })
  }
}
