export const AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = 2
export const AGENT_RATE_LIMIT_ENABLED = true
export const AGENT_RATE_LIMIT_MAX_REQUESTS = 5
export const AGENT_RATE_LIMIT_STORE = "memory"
export const AGENT_RATE_LIMIT_WINDOW_MS = 60_000
export const AGENT_STREAM_TIMEOUT_MS = 30_000
export const MEMORY_RUNTIME_CONFIG = {
  agentId: "chloei",
  commitMaxChars: 12_000,
  contextMaxChars: 3_000,
  mem0ApiKey: undefined,
  mem0ApiUrl: "http://localhost:8888",
  provider: "disabled",
  threshold: 0.3,
  topK: 6,
}
