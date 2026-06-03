import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import {
  createJsonErrorResponse,
  resolveRequestId,
} from "@/lib/server/agent-route"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import {
  fetchTradingDeskConfig,
  TradingAgentsServiceError,
} from "@/lib/server/trading-agents/client"
import { TRADINGAGENTS_ENABLED } from "@/lib/server/trading-agents/config"

export const runtime = "nodejs"

/** Proxy the sidecar's `/config` so the Trading Desk form can render. */
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`trading-desk-config:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/trading-desk/config",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse({ "X-Request-Id": requestId }),
        { errorCode: "AUTH_UNAVAILABLE", outcome: "auth_unavailable" }
      )
    }

    const session = await getRequestSession(request.headers)
    if (!session) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Unauthorized.",
          errorCode: "TRADING_DESK_UNAUTHORIZED",
          status: 401,
        }),
        { errorCode: "TRADING_DESK_UNAUTHORIZED", outcome: "unauthorized" }
      )
    }

    if (!TRADINGAGENTS_ENABLED) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Trading Desk is disabled.",
          errorCode: "TRADING_DESK_DISABLED",
          status: 503,
        }),
        { errorCode: "TRADING_DESK_DISABLED", outcome: "disabled" }
      )
    }

    const config = await fetchTradingDeskConfig(request.signal)
    return observeRouteResponse(
      observation,
      Response.json(config, {
        headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
      }),
      { outcome: "success" }
    )
  } catch (error) {
    const status =
      error instanceof TradingAgentsServiceError ? error.status : 502
    logger.error("Trading Desk config request failed.", {
      error,
      errorCode: "TRADING_DESK_SERVICE_ERROR",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createJsonErrorResponse({
        requestId,
        error:
          error instanceof Error
            ? error.message
            : "Failed to reach the TradingAgents service.",
        errorCode: "TRADING_DESK_SERVICE_ERROR",
        status,
      }),
      { errorCode: "TRADING_DESK_SERVICE_ERROR", outcome: "error" }
    )
  }
}
