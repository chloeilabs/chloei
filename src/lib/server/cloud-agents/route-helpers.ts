import { type NextRequest } from "next/server"
import { ZodError } from "zod"

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
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

import {
  isCloudAgentNotFoundError,
  isCloudAgentStoreNotInitializedError,
  isCloudAgentTransitionError,
} from "./errors"

export interface CloudAgentRouteContext {
  request: NextRequest
  requestId: string
  logger: ReturnType<typeof createLogger>
  observation: ReturnType<typeof createRouteObservation>
}

export function createCloudAgentRouteContext(params: {
  request: NextRequest
  method: "GET" | "POST" | "PATCH" | "DELETE"
  route: string
}): CloudAgentRouteContext {
  const requestId = resolveRequestIdFromHeaders(params.request.headers)
  const logger = createLogger(`cloud-agents:${requestId}`)
  return {
    request: params.request,
    requestId,
    logger,
    observation: createRouteObservation({
      logger,
      method: params.method,
      requestId,
      route: params.route,
    }),
  }
}

export function cloudAgentErrorResponse(
  context: CloudAgentRouteContext,
  params: { error: string; errorCode: string; status: number }
) {
  return observeRouteResponse(
    context.observation,
    createApiErrorResponse({
      requestId: context.requestId,
      error: params.error,
      errorCode: params.errorCode,
      status: params.status,
    }),
    {
      errorCode: params.errorCode,
      outcome:
        params.status === 401
          ? "unauthorized"
          : params.status === 403
            ? "forbidden"
            : params.status === 404
              ? "not_found"
              : params.status === 400
                ? "invalid_request"
                : "error",
    }
  )
}

export function cloudAgentJsonResponse(
  context: CloudAgentRouteContext,
  body: unknown,
  init: { status?: number } = {}
) {
  return observeRouteResponse(
    context.observation,
    Response.json(body, {
      status: init.status ?? 200,
      headers: createApiHeaders({ requestId: context.requestId }),
    }),
    { outcome: "success" }
  )
}

export async function requireCloudAgentSession(
  context: CloudAgentRouteContext
) {
  if (!isAuthConfigured()) {
    return observeRouteResponse(
      context.observation,
      createAuthUnavailableResponse(
        createApiHeaders({ requestId: context.requestId })
      ),
      { errorCode: "AUTH_UNAVAILABLE", outcome: "auth_unavailable" }
    )
  }

  const session = await getRequestSession(context.request.headers)
  if (!session) {
    return cloudAgentErrorResponse(context, {
      error: "Unauthorized.",
      errorCode: "CLOUD_AGENTS_UNAUTHORIZED",
      status: 401,
    })
  }
  return session
}

type ResolvedSession = NonNullable<
  Awaited<ReturnType<typeof getRequestSession>>
>

export async function requireCloudAgentsEnabled(
  context: CloudAgentRouteContext,
  session: ResolvedSession
) {
  const flags = await resolveAgentFeatureFlags({
    userEmail: session.user.email,
  })
  if (!flags.cloudAgentsEnabled) {
    return cloudAgentErrorResponse(context, {
      error: "Cloud agents are disabled.",
      errorCode: "CLOUD_AGENTS_DISABLED",
      status: 403,
    })
  }
  return flags
}

export function handleCloudAgentError(
  context: CloudAgentRouteContext,
  error: unknown,
  fallback: { error: string; errorCode: string }
) {
  if (error instanceof ZodError) {
    return cloudAgentErrorResponse(context, {
      error: "Invalid request payload.",
      errorCode: `${fallback.errorCode}_INVALID`,
      status: 400,
    })
  }
  if (isCloudAgentStoreNotInitializedError(error)) {
    context.logger.error("Cloud agent store is not initialized.", {
      error,
      errorCode: "CLOUD_AGENT_STORE_NOT_INITIALIZED",
      requestId: context.requestId,
    })
    return cloudAgentErrorResponse(context, {
      error: error.message,
      errorCode: "CLOUD_AGENT_STORE_NOT_INITIALIZED",
      status: 500,
    })
  }
  if (isCloudAgentNotFoundError(error)) {
    return cloudAgentErrorResponse(context, {
      error: error.message,
      errorCode: "CLOUD_AGENT_NOT_FOUND",
      status: 404,
    })
  }
  if (isCloudAgentTransitionError(error)) {
    return cloudAgentErrorResponse(context, {
      error: error.message,
      errorCode: "CLOUD_AGENT_INVALID_TRANSITION",
      status: 409,
    })
  }
  context.logger.error(fallback.error, {
    error,
    errorCode: fallback.errorCode,
    requestId: context.requestId,
  })
  return cloudAgentErrorResponse(context, {
    error: fallback.error,
    errorCode: fallback.errorCode,
    status: 500,
  })
}
