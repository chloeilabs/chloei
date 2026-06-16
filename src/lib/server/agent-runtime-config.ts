import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

// Request size limits (shared defaults).
export const AGENT_MAX_MESSAGES = AGENT_REQUEST_MAX_MESSAGES
export const AGENT_MAX_MESSAGE_CHARS = AGENT_REQUEST_MAX_MESSAGE_CHARS
export const AGENT_MAX_TOTAL_CHARS = AGENT_REQUEST_MAX_TOTAL_CHARS

// Timeouts (ms).
export const AGENT_STREAM_TIMEOUT_MS = 800_000
export const AI_GATEWAY_CLIENT_TIMEOUT_MS = 3_600_000

// Tool-step budget for the agent loop.
export const AGENT_TOOL_MAX_STEPS = 12
