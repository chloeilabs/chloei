import {
  startAgentRuntimeStream,
  type StartAgentRuntimeStreamParams,
} from "./agent-runtime"

type StartGatewayResponseStreamParams = StartAgentRuntimeStreamParams

export function startGatewayResponseStream(
  params: StartGatewayResponseStreamParams
) {
  return startAgentRuntimeStream(params)
}
