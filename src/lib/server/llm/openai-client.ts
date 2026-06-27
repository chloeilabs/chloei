import { getGlobalTraceProvider, setDefaultOpenAIKey } from "@openai/agents"

let tracingDisabled = false
let configuredKey: string | undefined

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
