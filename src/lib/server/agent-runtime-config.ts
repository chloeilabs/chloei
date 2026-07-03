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

// --- Goblins adaptive budgeting (agent.goblins.adaptive flag) ---
// A cheap triage pre-pass picks one of these tiers per request; the tier is the
// single source of truth for every budget in that run. The legacy constants
// above remain the flag-off values and double as the "standard" tier.
export const GOBLINS_BUDGET_TIER_IDS = ["quick", "standard", "deep"] as const
export type GoblinsBudgetTierId = (typeof GOBLINS_BUDGET_TIER_IDS)[number]

export interface GoblinsBudgetTier {
  id: GoblinsBudgetTierId
  // Hard cap passed to the manager's run().
  managerMaxTurns: number
  // Soft caps surfaced to the manager via its budget prompt line.
  maxDelegationRounds: number
  maxGoblinsPerRound: number
  goblinMaxToolSteps: number
  goblinReasoningEffort: "medium" | "high"
  managerReasoningEffort: "high" | "xhigh"
  // Deep tier only: attach the coverage_check judge before synthesis.
  evaluatorEnabled: boolean
}

export const GOBLINS_BUDGET_TIERS: Record<
  GoblinsBudgetTierId,
  GoblinsBudgetTier
> = {
  quick: {
    id: "quick",
    managerMaxTurns: 4,
    maxDelegationRounds: 1,
    maxGoblinsPerRound: 2,
    goblinMaxToolSteps: 3,
    goblinReasoningEffort: "medium",
    managerReasoningEffort: "high",
    evaluatorEnabled: false,
  },
  standard: {
    id: "standard",
    managerMaxTurns: GOBLINS_MANAGER_MAX_TURNS,
    maxDelegationRounds: 2,
    maxGoblinsPerRound: 4,
    goblinMaxToolSteps: GOBLIN_SUBAGENT_MAX_STEPS,
    goblinReasoningEffort: "high",
    managerReasoningEffort: "xhigh",
    evaluatorEnabled: false,
  },
  deep: {
    id: "deep",
    managerMaxTurns: 14,
    maxDelegationRounds: 3,
    maxGoblinsPerRound: 5,
    goblinMaxToolSteps: 8,
    goblinReasoningEffort: "high",
    managerReasoningEffort: "xhigh",
    evaluatorEnabled: true,
  },
}

// Triage pre-pass race timeout; on timeout (or any error) the run falls back to
// the standard tier — the pre-pass may never fail a run.
export const GOBLINS_TRIAGE_TIMEOUT_MS = 5_000
// Hosted web_search context size. Deliberately NOT per-tier: hosted tool
// configs serialize into the request prefix, and varying them would fragment
// each goblin's prompt cache line.
export const GOBLINS_WEB_SEARCH_CONTEXT_SIZE = "medium" as const
// file_search result cap for goblins that search user documents.
export const GOBLINS_FILE_SEARCH_MAX_RESULTS = 8
// Cap on the cross-goblin shared page-content cache (entries per request).
export const GOBLINS_SHARED_CONTENT_CACHE_MAX_ENTRIES = 40
// Wall-clock budget for one background continuation segment (goblin batch +
// next-turn dispatch) so it fits comfortably inside a single invocation.
export const GOBLINS_SEGMENT_BUDGET_MS = 600_000
