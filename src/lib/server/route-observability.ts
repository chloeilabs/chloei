import type { createLogger } from "@/lib/logger"

type Logger = ReturnType<typeof createLogger>

interface RouteObservationParams {
  logger: Logger
  method: string
  requestId: string
  route: string
}

interface RouteObservation extends RouteObservationParams {
  startedAt: number
}

interface RouteResponseDetails {
  errorCode?: string
  outcome: string
}

export function createRouteObservation(
  params: RouteObservationParams
): RouteObservation {
  return {
    ...params,
    startedAt: Date.now(),
  }
}

export function observeRouteResponse<T extends Response>(
  observation: RouteObservation,
  response: T,
  details: RouteResponseDetails
): T {
  observation.logger.info("API request completed.", {
    requestId: observation.requestId,
    route: observation.route,
    method: observation.method,
    status: response.status,
    durationMs: Date.now() - observation.startedAt,
    ...details,
  })

  return response
}
