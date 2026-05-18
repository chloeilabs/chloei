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
  createApiErrorResponse,
  createApiHeaders,
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

function isAvailableModel(model: ModelType): boolean {
  return getModels().some((availableModel) => availableModel.id === model)
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

    const body: unknown = await request.json()
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

    if (isE2eMockModeEnabled()) {
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

    const followUpQuestions = await generateFollowUpQuestions({
      aiGatewayApiKey,
      messages: parsed.messages,
      model: parsed.model,
      runMode: parsed.runMode,
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
