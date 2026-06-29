import { type Tool, tool } from "@openai/agents"
import { z } from "zod"

import { GOBLIN_SUBAGENT_MAX_STEPS } from "@/lib/server/agent-runtime-config"
import {
  type AgentStreamEvent,
  AvailableModels,
  type SubagentId,
} from "@/lib/shared"

import { startAgentRuntimeStream } from "./agent-runtime"

// One specialist sub-agent. `subagentId` is also the SDK tool name the manager
// sees, so the stream mapper can resolve manager tool calls back to the goblin.
export interface GoblinDefinition {
  subagentId: SubagentId
  // Human-facing label surfaced in the activity timeline ("Goblin: <label>").
  label: string
  // Shown to the GPT-5.5 manager so it can route work to the right specialist.
  toolDescription: string
  // The sub-agent's own system prompt (role framing).
  instructions: string
}

const GOBLIN_BASE_INSTRUCTIONS = [
  "You are a specialist research goblin reporting to a lead analyst. Goal: return a concise, well-sourced brief that answers your assigned task.",
  "Use the web-search tools (both the OpenAI web_search and the Exa search/read tools are available) to gather current evidence. Start with broad, natural-language queries and narrow only if needed; if a query returns little, broaden it rather than stacking site or date filters. Treat live results and the current date as the real present, not as future-dated or invented.",
  "Your value is the written brief, not the number of searches: once you can answer the task — or after a few searches when results are thin — stop searching and write. Ground each claim in the source URLs you used so the analyst can cite them, and note any gaps instead of declining.",
].join(" ")

export const GOBLIN_DEFINITIONS: GoblinDefinition[] = [
  {
    subagentId: "goblin_web_researcher",
    label: "Web Researcher",
    toolDescription:
      "Broad live-web discovery. Use for general fact-finding and gathering a wide base of relevant, current sources on the task.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is BROAD DISCOVERY: cast a wide net, find the most relevant and authoritative pages, and summarize the landscape of what is known.`,
  },
  {
    subagentId: "goblin_source_verifier",
    label: "Source Verifier",
    toolDescription:
      "Cross-checks specific claims against primary sources. Use when a claim needs verification or you need the authoritative original document.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is VERIFICATION: take the key claims, find primary/authoritative sources, read them closely, and report which claims hold up, which don't, and the exact supporting quotes.`,
  },
  {
    subagentId: "goblin_recency_scout",
    label: "Recency Scout",
    toolDescription:
      "Time-sensitive 'what is the latest' angle. Use for breaking developments, recent changes, or anything where freshness matters.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is RECENCY: bias toward the newest information, prefer recent results, and clearly date every finding so the manager knows how current it is.`,
  },
  {
    subagentId: "goblin_numbers_analyst",
    label: "Numbers Analyst",
    toolDescription:
      "Extracts and reconciles figures, metrics, and data from filings/reports. Use for quantitative questions, statistics, or financial detail.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is QUANTITATIVE DETAIL: find the hard numbers, reconcile figures across sources, note units/periods, and flag any discrepancies between sources.`,
  },
  {
    subagentId: "goblin_contrarian",
    label: "Contrarian",
    toolDescription:
      "Actively seeks disconfirming evidence and counterarguments. Use to stress-test a thesis and surface the strongest opposing view.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is DISCONFIRMATION: actively search for evidence that contradicts the leading view, surface the strongest counterarguments and caveats, and report what would have to be true for the opposite conclusion.`,
  },
  {
    subagentId: "goblin_context_scout",
    label: "Context Scout",
    toolDescription:
      "Gathers background, definitions, and framing. Use to establish context, history, and how the topic fits a bigger picture.",
    instructions: `${GOBLIN_BASE_INSTRUCTIONS} Your specialty is CONTEXT: establish definitions, background, and framing so the manager understands how the specifics fit the bigger picture.`,
  },
]

const GOBLIN_LABELS_BY_ID = new Map<SubagentId, string>(
  GOBLIN_DEFINITIONS.map((definition) => [
    definition.subagentId,
    definition.label,
  ])
)

// Maps a manager tool-call name back to a sub-agent. Used by the stream mapper
// to turn manager tool events into subagent_call / subagent_result events.
export function resolveGoblinSubagent(
  toolName: string
): { subagentId: SubagentId; label: string } | null {
  const label = GOBLIN_LABELS_BY_ID.get(toolName as SubagentId)
  if (!label) {
    return null
  }
  return { subagentId: toolName as SubagentId, label }
}

export interface CreateGoblinToolsParams {
  openAiApiKey: string
  exaApiKey?: string
  signal?: AbortSignal
  // Receives the goblin's own search activity (tool_call / tool_result / source)
  // so the orchestrator can surface it on the top-level stream.
  onSubEvent?: (event: AgentStreamEvent) => void
}

const goblinInputSchema = z.object({
  input: z
    .string()
    .describe("The focused, self-contained research task for this goblin."),
})

/**
 * Builds the up-to-6 specialist sub-agents (gpt-5.4-mini, xhigh) and exposes each
 * as a function tool the GPT-5.5 manager can call. Crucially, each goblin runs
 * through `startAgentRuntimeStream` — NOT the bare SDK `asTool` — so it inherits
 * the single-agent forced-synthesis fallback: if a goblin exhausts its tool-step
 * budget mid-search it still writes a brief from what it gathered instead of
 * returning a MaxTurnsExceededError string (which would leave the manager with no
 * research and make it refuse). The goblin's final text becomes the tool result
 * the manager reads; its search activity + sources are streamed up via onSubEvent.
 */
export function createGoblinTools(params: CreateGoblinToolsParams): Tool[] {
  return GOBLIN_DEFINITIONS.map((definition) =>
    tool({
      name: definition.subagentId,
      description: definition.toolDescription,
      parameters: goblinInputSchema,
      execute: async ({ input }) => {
        let brief = ""
        for await (const event of startAgentRuntimeStream({
          model: AvailableModels.OPENAI_GPT_5_4_MINI,
          // Goblins are evidence-gatherers, not the final writer, so "high" is
          // enough — "xhigh" on up-to-6 parallel sub-agents doing multi-step web
          // research is the latency long pole that pushes whole runs past the
          // 800s serverless cap. The GPT-5.5 manager keeps xhigh for synthesis.
          reasoningEffort: "high",
          maxToolSteps: GOBLIN_SUBAGENT_MAX_STEPS,
          openAiApiKey: params.openAiApiKey,
          exaApiKey: params.exaApiKey,
          messages: [{ role: "user", content: input }],
          systemInstruction: definition.instructions,
          // Each specialist's instructions are stable, so give it its own cache
          // line — the prefix is reused across requests that hit this goblin.
          promptCacheKey: definition.subagentId,
          signal: params.signal,
        })) {
          if (event.type === "text_delta") {
            brief += event.delta
          } else if (
            event.type === "tool_call" ||
            event.type === "tool_result" ||
            event.type === "source"
          ) {
            params.onSubEvent?.(event)
          }
        }
        return brief.trim() || "No findings could be gathered for this task."
      },
    })
  )
}
