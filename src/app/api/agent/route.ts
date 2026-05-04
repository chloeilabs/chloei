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
  createE2eAgentStreamResponse,
  isE2eMockModeEnabled,
} from "@/lib/server/e2e-test-mode"
import { resolveAgentHarnessConfig } from "@/lib/server/llm/agent-harness"
import {
  evaluateAndConsumeSlidingWindowRateLimit,
  tryAcquireConcurrencySlot,
} from "@/lib/server/rate-limit"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import { isThreadStoreNotInitializedError } from "@/lib/server/threads"

export const runtime = "nodejs"
export const maxDuration = 800

function resolveRateLimitIdentifier(userId: string): string {
  return `user:${userId}`
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`agent:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/agent",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse({ "X-Request-Id": requestId }),
        {
          errorCode: "AUTH_UNAVAILABLE",
          outcome: "auth_unavailable",
        }
      )
    }

    const aiGatewayApiKey = process.env.AI_GATEWAY_API_KEY
    const tavilyApiKey = process.env.TAVILY_API_KEY
    const fmpApiKey = process.env.FMP_API_KEY
    const isE2eMockRequest = isE2eMockModeEnabled()
    const session = await getRequestSession(request.headers)

    if (!session) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Unauthorized.",
          errorCode: "AGENT_UNAUTHORIZED",
          status: 401,
        }),
        {
          errorCode: "AGENT_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const clientIdentifier = resolveRateLimitIdentifier(session.user.id)
    const rateLimitDecision =
      AGENT_RATE_LIMIT_ENABLED && !isE2eMockRequest
        ? await evaluateAndConsumeSlidingWindowRateLimit({
            identifier: clientIdentifier,
            maxRequests: AGENT_RATE_LIMIT_MAX_REQUESTS,
            windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
          })
        : null

    if (rateLimitDecision && !rateLimitDecision.allowed) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Too many requests. Please retry shortly.",
          errorCode: "AGENT_RATE_LIMITED",
          status: 429,
          retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
          rateLimitDecision,
        }),
        {
          errorCode: "AGENT_RATE_LIMITED",
          outcome: "rate_limited",
        }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Invalid JSON payload.",
          errorCode: "AGENT_INVALID_JSON",
          status: 400,
          rateLimitDecision: rateLimitDecision ?? undefined,
        }),
        {
          errorCode: "AGENT_INVALID_JSON",
          outcome: "invalid_request",
        }
      )
    }

    const parsedRequestResult = parseAgentStreamRequest({
      body,
      availableModels: getModels(),
      requestId,
      rateLimitDecision: rateLimitDecision ?? undefined,
    })
    if (parsedRequestResult instanceof Response) {
      return observeRouteResponse(observation, parsedRequestResult, {
        errorCode: parsedRequestResult.headers.get("X-Error-Code") ?? undefined,
        outcome: "invalid_request",
      })
    }
    const { parsedRequest, selectedModel } = parsedRequestResult

    const requestNow = new Date()
    const userTimeZone = resolveUserTimeZone(request)
    const promptProvider = resolvePromptProvider(selectedModel)
    const promptTaskMode =
      parsedRequest.runMode === "research"
        ? "research"
        : inferPromptTaskMode(parsedRequest.messages)
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
    const harnessConfig = resolveAgentHarnessConfig({
      taskMode: promptTaskMode,
      runMode: parsedRequest.runMode,
      model: selectedModel,
    })

    if (isE2eMockRequest) {
      return observeRouteResponse(
        observation,
        createE2eAgentStreamResponse({ requestId }),
        {
          outcome: "stream_started",
        }
      )
    }

    if (!aiGatewayApiKey) {
      logger.error("Missing AI_GATEWAY_API_KEY on the server.", {
        errorCode: "AGENT_AI_GATEWAY_API_KEY_MISSING",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Missing AI_GATEWAY_API_KEY on the server.",
          errorCode: "AGENT_AI_GATEWAY_API_KEY_MISSING",
          status: 500,
          rateLimitDecision: rateLimitDecision ?? undefined,
        }),
        {
          errorCode: "AGENT_AI_GATEWAY_API_KEY_MISSING",
          outcome: "error",
        }
      )
    }

    const concurrencySlot = AGENT_RATE_LIMIT_ENABLED
      ? await tryAcquireConcurrencySlot({
          identifier: clientIdentifier,
          maxConcurrent: AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
          windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
        })
      : null

    if (concurrencySlot && !concurrencySlot.allowed) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Too many concurrent requests. Please retry shortly.",
          errorCode: "AGENT_CONCURRENCY_LIMITED",
          status: 429,
          retryAfterSeconds: concurrencySlot.retryAfterSeconds,
          rateLimitDecision: rateLimitDecision ?? undefined,
        }),
        {
          errorCode: "AGENT_CONCURRENCY_LIMITED",
          outcome: "rate_limited",
        }
      )
    }

    return observeRouteResponse(
      observation,
      createAgentStreamResponse({
        request,
        requestId,
        rateLimitDecision: rateLimitDecision ?? undefined,
        timeoutMs: AGENT_STREAM_TIMEOUT_MS,
        selectedModel,
        aiGatewayApiKey,
        tavilyApiKey,
        fmpApiKey,
        userTimeZone,
        runtimeProfile: harnessConfig.runtimeProfile,
        messages: parsedRequest.messages,
        systemInstruction,
        onStreamSettled: concurrencySlot?.release,
      }),
      {
        outcome: "stream_started",
      }
    )
  } catch (error) {
    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: error.message,
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          status: 500,
        }),
        {
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          outcome: "error",
        }
      )
    }

    logger.error("Agent request failed.", {
      error,
      errorCode: "AGENT_REQUEST_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createJsonErrorResponse({
        requestId,
        error: "Failed to generate agent response.",
        errorCode: "AGENT_REQUEST_FAILED",
        status: 500,
      }),
      {
        errorCode: "AGENT_REQUEST_FAILED",
        outcome: "error",
      }
    )
  }
}
