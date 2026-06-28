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

// --- Goblins (multi-agent) mode ---
// Max specialist sub-agents the GPT-5.5 manager can delegate to.
export const GOBLIN_COUNT = 6
// Per-goblin tool-step budget. Each goblin runs through startAgentRuntimeStream
// (xhigh), so it keeps that runtime's forced-synthesis fallback when it runs out
// — but xhigh turns are slow, so we cap this low to keep the whole fan-out fast.
// On overrun the goblin still writes a brief from what it gathered.
export const GOBLIN_SUBAGENT_MAX_STEPS = 5
// Manager budget. One parallel delegation round costs a single turn, so this
// only needs headroom for ~1-2 rounds plus the synthesis turn. Kept low as a
// hard backstop against runaway iterative delegation (the prompt asks for a
// single round); on overrun the forced synthesis still writes the answer.
export const GOBLINS_MANAGER_MAX_TURNS = 8
