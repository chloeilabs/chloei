import { type NextRequest } from "next/server"

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
  fetchTradingDeskConfig,
  TradingAgentsServiceError,
} from "@/lib/server/trading-agents/client"
import { TRADINGAGENTS_ENABLED } from "@/lib/server/trading-agents/config"

export const runtime = "nodejs"

/** Proxy the sidecar's `/config` so the Trading Desk form can render. */
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

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

  try {
    const config = await fetchTradingDeskConfig(request.signal)
    return Response.json(config, {
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    })
  } catch (error) {
    const status =
      error instanceof TradingAgentsServiceError ? error.status : 502
    return createJsonErrorResponse({
      requestId,
      error:
        error instanceof Error
          ? error.message
          : "Failed to reach the TradingAgents service.",
      errorCode: "TRADING_DESK_SERVICE_ERROR",
      status,
    })
  }
}
