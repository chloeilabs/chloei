import { type NextRequest, NextResponse } from "next/server"

import { getModels } from "@/lib/actions/api-keys"
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
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`models:${requestId}`)
  const headers = createApiHeaders({ requestId })
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/models",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse(headers),
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
        createApiErrorResponse({
          requestId,
          error: "Unauthorized.",
          errorCode: "MODELS_UNAUTHORIZED",
          status: 401,
          headers,
        }),
        {
          errorCode: "MODELS_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const models = getModels()
    return observeRouteResponse(
      observation,
      NextResponse.json(models, {
        headers,
      }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    logger.error("Failed to fetch model list.", {
      error,
      errorCode: "MODELS_FETCH_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createApiErrorResponse({
        requestId,
        error: "Failed to fetch models.",
        errorCode: "MODELS_FETCH_FAILED",
        status: 500,
        headers,
      }),
      {
        errorCode: "MODELS_FETCH_FAILED",
        outcome: "error",
      }
    )
  }
}
