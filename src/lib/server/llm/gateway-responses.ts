import { AvailableModels } from "@/lib/shared"

import {
  startAgentRuntimeStream,
  type StartAgentRuntimeStreamParams,
} from "./agent-runtime"
import { startGoblinsRuntimeStream } from "./goblins-runtime"

type StartGatewayResponseStreamParams = StartAgentRuntimeStreamParams

export function startGatewayResponseStream(
  params: StartGatewayResponseStreamParams
) {
  // "Goblins" is a virtual model id: branch to the multi-agent orchestrator
  // before any real model id reaches the single-model runtime / SDK.
  if (params.model === AvailableModels.OPENAI_GOBLINS) {
    return startGoblinsRuntimeStream(params)
  }
  return startAgentRuntimeStream(params)
}
