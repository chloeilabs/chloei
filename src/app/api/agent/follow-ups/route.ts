import { type NextRequest, NextResponse } from "next/server"
import { ZodError } from "zod"

import { getModels } from "@/lib/actions/api-keys"
import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  followUpQuestionsResponseSchema,
  followUpRequestSchema,
  generateFollowUpQuestions,
  validateFollowUpMessages,
} from "@/lib/server/agent-follow-ups"
import {
  AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  AGENT_RATE_LIMIT_ENABLED,
  AGENT_RATE_LIMIT_MAX_REQUESTS,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from "@/lib/server/agent-runtime-config"
import {
  createApiHeaders,
  createErrorResponse,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  createE2eFollowUpQuestionsResponse,
  isE2eMockModeEnabled,
} from "@/lib/server/e2e-test-mode"
import {
  evaluateAndConsumeSlidingWindowRateLimit,
  tryAcquireConcurrencySlot,
} from "@/lib/server/rate-limit"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import { isModelType, type ModelType } from "@/lib/shared"

export const runtime = "nodejs"

function createEmptyFollowUpResponse(requestId: string) {
  return NextResponse.json(
    followUpQuestionsResponseSchema.parse({ followUpQuestions: [] }),
    {
      headers: createApiHeaders({ requestId }),
    }
  )
}

function createRetryAfterHeaders(retryAfterSeconds: number | null): Headers {
  const headers = new Headers()
  if (retryAfterSeconds !== null) {
    headers.set("Retry-After", String(retryAfterSeconds))
  }

  return headers
}

function isAvailableModel(model: ModelType): boolean {
  return getModels().some((availableModel) => availableModel.id === model)
}

function resolveRateLimitIdentifier(userId: string): string {
  return `user:${userId}`
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`agent-follow-ups:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/agent/follow-ups",
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
          "FOLLOW_UPS_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "FOLLOW_UPS_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const isE2eMockRequest = isE2eMockModeEnabled()
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
        createErrorResponse(
          requestId,
          "Too many requests. Please retry shortly.",
          "FOLLOW_UPS_RATE_LIMITED",
          429,
          createRetryAfterHeaders(rateLimitDecision.retryAfterSeconds)
        ),
        {
          errorCode: "FOLLOW_UPS_RATE_LIMITED",
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
        createErrorResponse(
          requestId,
          "Invalid JSON payload.",
          "FOLLOW_UPS_INVALID_JSON",
          400
        ),
        {
          errorCode: "FOLLOW_UPS_INVALID_JSON",
          outcome: "invalid_request",
        }
      )
    }

    const parsed = followUpRequestSchema.parse(body)
    if (!isModelType(parsed.model)) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Unsupported model selected.",
          "FOLLOW_UPS_UNSUPPORTED_MODEL",
          400
        ),
        {
          errorCode: "FOLLOW_UPS_UNSUPPORTED_MODEL",
          outcome: "invalid_request",
        }
      )
    }

    if (!validateFollowUpMessages(parsed.messages)) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid follow-up context.",
          "FOLLOW_UPS_INVALID_CONTEXT",
          400
        ),
        {
          errorCode: "FOLLOW_UPS_INVALID_CONTEXT",
          outcome: "invalid_request",
        }
      )
    }

    if (isE2eMockRequest) {
      return observeRouteResponse(
        observation,
        createE2eFollowUpQuestionsResponse({ requestId }),
        {
          outcome: "success",
        }
      )
    }

    const aiGatewayApiKey = process.env.AI_GATEWAY_API_KEY?.trim()
    if (!aiGatewayApiKey || !isAvailableModel(parsed.model)) {
      return observeRouteResponse(
        observation,
        createEmptyFollowUpResponse(requestId),
        {
          outcome: "disabled",
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
        createErrorResponse(
          requestId,
          "Too many concurrent requests. Please retry shortly.",
          "FOLLOW_UPS_CONCURRENCY_LIMITED",
          429,
          createRetryAfterHeaders(concurrencySlot.retryAfterSeconds)
        ),
        {
          errorCode: "FOLLOW_UPS_CONCURRENCY_LIMITED",
          outcome: "rate_limited",
        }
      )
    }

    try {
      const followUpQuestions = await generateFollowUpQuestions({
        aiGatewayApiKey,
        messages: parsed.messages,
        model: parsed.model,
        signal: request.signal,
        userId: session.user.id,
      })

      return observeRouteResponse(
        observation,
        NextResponse.json(
          followUpQuestionsResponseSchema.parse({ followUpQuestions }),
          {
            headers: createApiHeaders({ requestId }),
          }
        ),
        {
          outcome: "success",
        }
      )
    } finally {
      await concurrencySlot?.release()
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid follow-up request.",
          "FOLLOW_UPS_INVALID_REQUEST",
          400
        ),
        {
          errorCode: "FOLLOW_UPS_INVALID_REQUEST",
          outcome: "invalid_request",
        }
      )
    }

    logger.warn("Failed to generate follow-up questions.", {
      error,
      errorCode: "FOLLOW_UPS_GENERATION_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createEmptyFollowUpResponse(requestId),
      {
        errorCode: "FOLLOW_UPS_GENERATION_FAILED",
        outcome: "generation_failed",
      }
    )
  }
}
