import { type NextRequest, NextResponse } from "next/server"

import { getModels } from "@/lib/actions/api-keys"
import { createLogger } from "@/lib/logger"
import { createApiErrorResponse, createApiHeaders } from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const logger = createLogger(`models:${requestId}`)
  const headers = createApiHeaders({ requestId })

  try {
    if (!isAuthConfigured()) {
      return createAuthUnavailableResponse(headers)
    }

    const session = await getRequestSession(request.headers)

    if (!session) {
      return createApiErrorResponse({
        requestId,
        error: "Unauthorized.",
        errorCode: "MODELS_UNAUTHORIZED",
        status: 401,
        headers,
      })
    }

    const models = getModels()
    return NextResponse.json(models, {
      headers,
    })
  } catch (error) {
    logger.error("Failed to fetch model list.", {
      error,
      errorCode: "MODELS_FETCH_FAILED",
      requestId,
    })
    return createApiErrorResponse({
      requestId,
      error: "Failed to fetch models.",
      errorCode: "MODELS_FETCH_FAILED",
      status: 500,
      headers,
    })
  }
}
