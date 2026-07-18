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

// Rendered-token threshold that triggers OpenAI server-side context compaction
// within a run (only when the responseCompaction flag is on). Set below the
// model context window so very long agentic loops get compacted before they
// blow the budget; typical runs stay well under this and never compact.
export const RESPONSE_COMPACTION_TOKEN_THRESHOLD = 100_000
