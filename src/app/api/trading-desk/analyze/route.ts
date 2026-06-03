import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import {
  createJsonErrorResponse,
  resolveRequestId,
} from "@/lib/server/agent-route"
import {
  AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  AGENT_RATE_LIMIT_ENABLED,
  AGENT_RATE_LIMIT_MAX_REQUESTS,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from "@/lib/server/agent-runtime-config"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  evaluateAndConsumeSlidingWindowRateLimit,
  tryAcquireConcurrencySlot,
} from "@/lib/server/rate-limit"
import {
  streamTradingDeskAnalysis,
  TradingAgentsServiceError,
} from "@/lib/server/trading-agents/client"
import { TRADINGAGENTS_ENABLED } from "@/lib/server/trading-agents/config"
import { tradingDeskRequestSchema } from "@/lib/server/trading-agents/request-schema"

export const runtime = "nodejs"
export const maxDuration = 800

function resolveRateLimitIdentifier(userId: string): string {
  return `trading-desk:user:${userId}`
}

/**
 * Wrap a stream so `cleanup` runs exactly once when it ends, errors, or is
 * cancelled — used to release the concurrency slot however the stream closes.
 */
function withCleanup(
  stream: ReadableStream<Uint8Array>,
  cleanup: () => void | Promise<void>
): ReadableStream<Uint8Array> {
  let finished = false
  const runCleanup = () => {
    if (finished) {
      return
    }
    finished = true
    void cleanup()
  }
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          runCleanup()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        runCleanup()
        controller.error(error)
      }
    },
    cancel(reason) {
      runCleanup()
      return reader.cancel(reason)
    },
  })
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`trading-desk:${requestId}`)

  if (!isAuthConfigured()) {
    return createAuthUnavailableResponse({ "X-Request-Id": requestId })
  }

  const session = await getRequestSession(request.headers)
  if (!session) {
    return createJsonErrorResponse({
      requestId,
      error: "Unauthorized.",
      errorCode: "TRADING_DESK_UNAUTHORIZED",
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

  const clientIdentifier = resolveRateLimitIdentifier(session.user.id)
  const rateLimitDecision = AGENT_RATE_LIMIT_ENABLED
    ? await evaluateAndConsumeSlidingWindowRateLimit({
        identifier: clientIdentifier,
        maxRequests: AGENT_RATE_LIMIT_MAX_REQUESTS,
        windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
      })
    : null
  if (rateLimitDecision && !rateLimitDecision.allowed) {
    return createJsonErrorResponse({
      requestId,
      error: "Too many requests. Please retry shortly.",
      errorCode: "TRADING_DESK_RATE_LIMITED",
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
      errorCode: "TRADING_DESK_INVALID_JSON",
      status: 400,
    })
  }

  const parsed = tradingDeskRequestSchema.safeParse(body)
  if (!parsed.success) {
    return createJsonErrorResponse({
      requestId,
      error: parsed.error.issues[0]?.message ?? "Invalid request.",
      errorCode: "TRADING_DESK_INVALID_REQUEST",
      status: 400,
    })
  }

  // Acquire a concurrency slot only once the request is valid; release it
  // when the stream finishes or the client disconnects.
  const concurrencySlot = AGENT_RATE_LIMIT_ENABLED
    ? await tryAcquireConcurrencySlot({
        identifier: clientIdentifier,
        maxConcurrent: AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
        windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
      })
    : null
  if (concurrencySlot && !concurrencySlot.allowed) {
    return createJsonErrorResponse({
      requestId,
      error: "An analysis is already running. Please wait for it to finish.",
      errorCode: "TRADING_DESK_CONCURRENCY_LIMITED",
      status: 429,
    })
  }

  try {
    const ndjsonStream = await streamTradingDeskAnalysis(
      {
        ticker: parsed.data.ticker.toUpperCase(),
        tradeDate: parsed.data.tradeDate ?? null,
        analysts: parsed.data.analysts,
        depth: parsed.data.depth,
        assetType: parsed.data.assetType,
        online: parsed.data.online,
        mock: parsed.data.mock ?? null,
      },
      request.signal
    )

    const stream = withCleanup(ndjsonStream, () => {
      void concurrencySlot?.release()
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Request-Id": requestId,
      },
    })
  } catch (error) {
    void concurrencySlot?.release()
    const status =
      error instanceof TradingAgentsServiceError ? error.status : 502
    logger.error("Trading Desk analyze failed", { error })
    return createJsonErrorResponse({
      requestId,
      error:
        error instanceof Error
          ? error.message
          : "Failed to start the analysis.",
      errorCode: "TRADING_DESK_SERVICE_ERROR",
      status,
    })
  }
}
