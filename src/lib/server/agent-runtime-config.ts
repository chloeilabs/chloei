import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

// Request size limits (shared defaults).
export const AGENT_MAX_MESSAGES = AGENT_REQUEST_MAX_MESSAGES
export const AGENT_MAX_MESSAGE_CHARS = AGENT_REQUEST_MAX_MESSAGE_CHARS
export const AGENT_MAX_TOTAL_CHARS = AGENT_REQUEST_MAX_TOTAL_CHARS

// Timeouts (ms). The agent run is bounded by the route's combined abort signal
// (request signal + AGENT_STREAM_TIMEOUT_MS).
export const AGENT_STREAM_TIMEOUT_MS = 800_000

// Tool-step budget for the agent loop.
export const AGENT_TOOL_MAX_STEPS = 12
