/**
 * Server-side configuration for the TradingAgents sidecar service.
 *
 * The Chloei app never talks to the Python service from the browser — these
 * routes proxy it server-side so the service URL and shared token stay private
 * and requests can be authenticated + rate limited first.
 */

const DEFAULT_SERVICE_URL = "http://localhost:8000"
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // a deep run can take a few minutes

/** Base URL of the sidecar, no trailing slash. */
const configuredServiceUrl = process.env.TRADINGAGENTS_SERVICE_URL?.trim()
export const TRADINGAGENTS_SERVICE_URL = (
  configuredServiceUrl && configuredServiceUrl.length > 0
    ? configuredServiceUrl
    : DEFAULT_SERVICE_URL
).replace(/\/+$/, "")

/** Optional shared secret; sent as `X-Service-Token` when set. */
export const TRADINGAGENTS_SERVICE_TOKEN =
  process.env.TRADINGAGENTS_SERVICE_TOKEN?.trim() ?? ""

/** Feature gate. Defaults on so the Trading Desk works against a local service. */
export const TRADINGAGENTS_ENABLED =
  (process.env.TRADINGAGENTS_ENABLED ?? "true").trim().toLowerCase() !== "false"

export const TRADINGAGENTS_REQUEST_TIMEOUT_MS = (() => {
  const raw = process.env.TRADINGAGENTS_REQUEST_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
})()

/** Headers for every request to the sidecar. */
export function tradingAgentsServiceHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (TRADINGAGENTS_SERVICE_TOKEN) {
    headers["X-Service-Token"] = TRADINGAGENTS_SERVICE_TOKEN
  }
  return headers
}
