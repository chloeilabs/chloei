import { Agent, run } from "@openai/agents"
import { z } from "zod"

import { createLogger } from "@/lib/logger"
import {
  GOBLINS_BUDGET_TIER_IDS,
  GOBLINS_BUDGET_TIERS,
  GOBLINS_TRIAGE_TIMEOUT_MS,
  type GoblinsBudgetTier,
} from "@/lib/server/agent-runtime-config"
import { AvailableModels, SUBAGENT_IDS, type SubagentId } from "@/lib/shared"

import { summarizeRunUsage } from "./agent-runtime"
import {
  type AgentInputMessage,
  toAgentInputItems,
} from "./agent-runtime-messages"

const logger = createLogger("goblins-triage")

// Stable classifier prefix gets its own cache line, mirroring the per-goblin
// prompt cache keys.
const GOBLINS_TRIAGE_CACHE_KEY = "goblins-triage"

const TRIAGE_INSTRUCTION = [
  "You size research questions for a multi-agent research team. Classify the user's LATEST request into exactly one budget tier:",
  "quick — a single fact, definition, or narrow lookup one specialist can settle in a couple of searches.",
  "standard — typical research needing a few specialists across multiple sources (most requests).",
  "deep — multi-entity comparisons, contested or high-stakes claims, quantitative reconciliation across sources, or explicit asks for thorough/exhaustive research.",
  "Optionally suggest which specialists fit best. Judge only the scope of work; never answer the question itself.",
].join(" ")

const triageOutputSchema = z.object({
  tier: z.enum(GOBLINS_BUDGET_TIER_IDS),
  suggestedGoblins: z
    .array(z.enum(SUBAGENT_IDS))
    .max(5)
    .optional()
    .describe("Specialists most likely to be useful for this request."),
})

export interface GoblinsTriageResult {
  tier: GoblinsBudgetTier
  suggestedGoblins?: SubagentId[]
  source: "classifier" | "fallback"
}

const FALLBACK_RESULT: GoblinsTriageResult = {
  tier: GOBLINS_BUDGET_TIERS.standard,
  source: "fallback",
}

/**
 * Sizes a Goblins request into a budget tier with one cheap gpt-5.4-mini pass.
 * Raced against GOBLINS_TRIAGE_TIMEOUT_MS; any timeout, abort, or model error
 * falls back to the standard tier — the pre-pass may never fail a run.
 */
export async function classifyGoblinsQuery(params: {
  openAiApiKey: string
  messages: AgentInputMessage[]
  requestId?: string
  signal?: AbortSignal
}): Promise<GoblinsTriageResult> {
  const inputItems = toAgentInputItems(params.messages)
  if (inputItems.length === 0) {
    return FALLBACK_RESULT
  }

  const startedAt = Date.now()
  try {
    const signal = params.signal
      ? AbortSignal.any([
          params.signal,
          AbortSignal.timeout(GOBLINS_TRIAGE_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(GOBLINS_TRIAGE_TIMEOUT_MS)

    const triageAgent = new Agent({
      name: "goblins-triage",
      instructions: TRIAGE_INSTRUCTION,
      model: AvailableModels.OPENAI_GPT_5_4_MINI,
      modelSettings: {
        reasoning: { effort: "minimal" },
        providerData: { prompt_cache_key: GOBLINS_TRIAGE_CACHE_KEY },
      },
      outputType: triageOutputSchema,
    })

    const result = await run(triageAgent, inputItems, {
      maxTurns: 1,
      signal,
    })

    const parsed = triageOutputSchema.safeParse(result.finalOutput)
    if (!parsed.success) {
      logger.warn("Goblins triage returned no parsable tier; using fallback.", {
        requestId: params.requestId,
      })
      return FALLBACK_RESULT
    }

    logger.info("Goblins triage classified the request.", {
      requestId: params.requestId,
      tier: parsed.data.tier,
      suggestedGoblins: parsed.data.suggestedGoblins,
      durationMs: Date.now() - startedAt,
      usage: summarizeRunUsage(result.state.usage),
    })

    return {
      tier: GOBLINS_BUDGET_TIERS[parsed.data.tier],
      ...(parsed.data.suggestedGoblins &&
      parsed.data.suggestedGoblins.length > 0
        ? { suggestedGoblins: parsed.data.suggestedGoblins }
        : {}),
      source: "classifier",
    }
  } catch (error) {
    logger.warn("Goblins triage failed; using the standard tier.", {
      requestId: params.requestId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    return FALLBACK_RESULT
  }
}
