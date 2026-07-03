export const AGENT_STREAM_TIMEOUT_MS = 30_000
export const AGENT_TOOL_MAX_STEPS = 12
export const RESPONSE_COMPACTION_TOKEN_THRESHOLD = 100_000
export const GOBLIN_COUNT = 6
export const GOBLIN_SUBAGENT_MAX_STEPS = 5
export const GOBLINS_MANAGER_MAX_TURNS = 8

// Goblins adaptive-orchestration constants (mirror the real tier table).
export const GOBLINS_BUDGET_TIER_IDS = ["quick", "standard", "deep"]
export const GOBLINS_BUDGET_TIERS = {
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
    managerMaxTurns: 8,
    maxDelegationRounds: 2,
    maxGoblinsPerRound: 4,
    goblinMaxToolSteps: 5,
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
export const GOBLINS_TRIAGE_TIMEOUT_MS = 5_000
export const GOBLINS_WEB_SEARCH_CONTEXT_SIZE = "medium"
export const GOBLINS_FILE_SEARCH_MAX_RESULTS = 8
export const GOBLINS_SHARED_CONTENT_CACHE_MAX_ENTRIES = 40
export const GOBLINS_SEGMENT_BUDGET_MS = 600_000
