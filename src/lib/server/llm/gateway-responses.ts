import {
  startAgentRuntimeStream,
  type StartAgentRuntimeStreamParams,
} from "./agent-runtime"

export type StartGatewayResponseStreamParams = StartAgentRuntimeStreamParams

export function startGatewayResponseStream(
  params: StartGatewayResponseStreamParams
) {
  return startAgentRuntimeStream(params)
}
