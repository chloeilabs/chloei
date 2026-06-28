import {
  getGlobalTraceProvider,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
} from "@openai/agents"

let tracingDisabled = false
let configuredKey: string | undefined
let configuredTransport: "http" | "websocket" | undefined

/**
 * Selects the transport the Agents SDK uses for Responses API calls. WebSocket
 * cuts per-round-trip overhead on tool-heavy runs (at the cost of a persistent
 * connection + a 60-minute socket cap). Global + idempotent; the flag value is
 * environment-wide, so flipping it per run is safe.
 */
export function configureResponsesTransport(useWebSocket: boolean): void {
  const transport = useWebSocket ? "websocket" : "http"
  if (configuredTransport !== transport) {
    setOpenAIResponsesTransport(transport)
    configuredTransport = transport
  }
}

/**
 * Configures the OpenAI Agents SDK for this server process: sets the default
 * API key used by all `run()` calls and disables tracing so agent-run data is
 * not exported to OpenAI's traces dashboard. Idempotent per key.
 */
export function configureOpenAiForAgents(apiKey: string): void {
  if (!tracingDisabled) {
    getGlobalTraceProvider().setDisabled(true)
    tracingDisabled = true
  }

  if (configuredKey !== apiKey) {
    setDefaultOpenAIKey(apiKey)
    configuredKey = apiKey
  }
}
