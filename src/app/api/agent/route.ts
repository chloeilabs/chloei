import { type NextRequest } from "next/server"

import { getModels } from "@/lib/actions/api-keys"
import { createLogger } from "@/lib/logger"
import { buildAgentSystemInstruction } from "@/lib/server/agent-context"
import {
  inferPromptTaskMode,
  resolvePromptProvider,
} from "@/lib/server/agent-prompt-steering"
import {
  createAgentStreamResponse,
  createJsonErrorResponse,
  parseAgentStreamRequest,
  resolveRequestId,
  resolveUserTimeZone,
} from "@/lib/server/agent-route"
import {
  AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  AGENT_RATE_LIMIT_ENABLED,
  AGENT_RATE_LIMIT_MAX_REQUESTS,
  AGENT_RATE_LIMIT_WINDOW_MS,
  AGENT_STREAM_TIMEOUT_MS,
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
import { isThreadStoreNotInitializedError } from "@/lib/server/threads"

export const runtime = "nodejs"

function resolveRateLimitIdentifier(userId: string): string {
  return `user:${userId}`
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`agent:${requestId}`)

  try {
    if (!isAuthConfigured()) {
      return createAuthUnavailableResponse({ "X-Request-Id": requestId })
    }

    const openRouterApiKey = process.env.OPENROUTER_API_KEY
    const tavilyApiKey = process.env.TAVILY_API_KEY
    const fmpApiKey = process.env.FMP_API_KEY
    const session = await getRequestSession(request.headers)

    if (!session) {
      return createJsonErrorResponse({
        requestId,
        error: "Unauthorized.",
        status: 401,
      })
    }

    const clientIdentifier = resolveRateLimitIdentifier(session.user.id)
    const rateLimitDecision = AGENT_RATE_LIMIT_ENABLED
      ? evaluateAndConsumeSlidingWindowRateLimit({
          identifier: clientIdentifier,
          maxRequests: AGENT_RATE_LIMIT_MAX_REQUESTS,
          windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
        })
      : null

    if (rateLimitDecision && !rateLimitDecision.allowed) {
      return createJsonErrorResponse({
        requestId,
        error: "Too many requests. Please retry shortly.",
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
        status: 400,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const parsedRequestResult = parseAgentStreamRequest({
      body,
      availableModels: getModels(),
      requestId,
      rateLimitDecision: rateLimitDecision ?? undefined,
    })
    if (parsedRequestResult instanceof Response) {
      return parsedRequestResult
    }
    const { parsedRequest, selectedModel } = parsedRequestResult

    const requestNow = new Date()
    const userTimeZone = resolveUserTimeZone(request)
    const promptProvider = resolvePromptProvider(selectedModel)
    const promptTaskMode = inferPromptTaskMode(parsedRequest.messages)
    const systemInstruction = buildAgentSystemInstruction(
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      {
        now: requestNow,
        userTimeZone,
        provider: promptProvider,
        taskMode: promptTaskMode,
      }
    )

    if (!openRouterApiKey) {
      return createJsonErrorResponse({
        requestId,
        error: "Missing OPENROUTER_API_KEY on the server.",
        status: 500,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const concurrencySlot = AGENT_RATE_LIMIT_ENABLED
      ? tryAcquireConcurrencySlot({
          identifier: clientIdentifier,
          maxConcurrent: AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
          windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
        })
      : null

    if (concurrencySlot && !concurrencySlot.allowed) {
      return createJsonErrorResponse({
        requestId,
        error: "Too many concurrent requests. Please retry shortly.",
        status: 429,
        retryAfterSeconds: concurrencySlot.retryAfterSeconds,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    return createAgentStreamResponse({
      request,
      requestId,
      rateLimitDecision: rateLimitDecision ?? undefined,
      timeoutMs: AGENT_STREAM_TIMEOUT_MS,
      selectedModel,
      openRouterApiKey,
      tavilyApiKey,
      fmpApiKey,
      messages: parsedRequest.messages,
      systemInstruction,
      onStreamSettled: concurrencySlot?.release,
    })
  } catch (error) {
    if (isThreadStoreNotInitializedError(error)) {
      return createJsonErrorResponse({
        requestId,
        error: error.message,
        status: 500,
      })
    }

    logger.error("Agent request failed.", error)
    return createJsonErrorResponse({
      requestId,
      error: "Failed to generate agent response.",
      status: 500,
    })
  }
}
