import {
  Agent,
  type AgentInputItem,
  MaxTurnsExceededError,
  run,
  type Tool,
  tool,
} from "@openai/agents"
import { z } from "zod"

import { createLogger } from "@/lib/logger"
import {
  GOBLINS_BUDGET_TIERS,
  GOBLINS_MANAGER_MAX_TURNS,
  type GoblinsBudgetTier,
} from "@/lib/server/agent-runtime-config"
import {
  type AgentStreamEvent,
  AvailableModels,
  GOBLINS_MANAGER_MODEL,
} from "@/lib/shared"

import {
  FINAL_SYNTHESIS_STEP_INSTRUCTION,
  FINAL_SYNTHESIS_USER_PROMPT,
  resolveContextManagementSettings,
  type StartAgentRuntimeStreamParams,
  summarizeRunUsage,
} from "./agent-runtime"
import { toAgentInputItems } from "./agent-runtime-messages"
import { createAgentStreamMapper, readTextDelta } from "./agent-stream-mapping"
import { createGoblinTools, resolveGoblinSubagent } from "./goblins-agents"
import {
  classifyGoblinsQuery,
  type GoblinsTriageResult,
} from "./goblins-triage"
import { createSharedResearchState } from "./openai-agents-exa-tools"
import {
  configureOpenAiForAgents,
  configureResponsesTransport,
} from "./openai-client"

const logger = createLogger("goblins-runtime")

// Cache key for the GPT-5.5 manager's stable orchestration prefix.
const GOBLINS_MANAGER_CACHE_KEY = "goblins-manager"

// "Goblins" mode reuses the single-model params shape so the gateway branch is a
// drop-in. params.model is always "goblins"; the real models are fixed here
// (manager = GPT-5.5, sub-agents = gpt-5.4-mini), all at xhigh reasoning.
export type StartGoblinsRuntimeStreamParams = StartAgentRuntimeStreamParams

// Legacy (flag-off) instruction — byte-identical to preserve the manager's 24h
// prompt cache line. Exported so the background continuation engine (Part B)
// drives its raw Responses turns from the same constants.
export const MANAGER_ORCHESTRATION_INSTRUCTION = [
  "You are the lead analyst. Goal: deliver a thorough, well-structured, accurately cited answer to the user's request.",
  "Your specialist research goblins are your tools, and they are your only access to the live web — you cannot search or browse directly. So when the answer depends on current, external, or uncertain information, delegate to the relevant goblins to gather evidence; calling a goblin is how you search the web.",
  "Pick the goblins that fit the question (usually two to four) and dispatch them in ONE parallel batch, then wait for their briefs. Treat this as a single delegation round: reconcile what comes back and write the answer — do not spawn repeated rounds chasing more sources. Only delegate again if a brief reveals a specific, essential gap.",
  "Write the final answer yourself, synthesized across the briefs rather than relaying any single goblin's text. Treat the goblins' sourced findings and the current date as authoritative reflections of the present; build on them instead of second-guessing or declining. If the evidence is thin, give what was found and name the gaps.",
  "You are done when the answer is grounded in the goblins' evidence, cites those sources inline, mirrors the user's exact terminology, and directly resolves the request.",
].join(" ")

// Adaptive (flag-on) instruction: multi-round delegation with knownFindings
// hand-off between rounds and GOBLIN_ERROR handling. Stable core — the
// per-request budget line is appended separately, after the already-volatile
// system blocks, so it never breaks this prefix's cache line.
export const MANAGER_ORCHESTRATION_INSTRUCTION_V2 = [
  "You are the lead analyst. Goal: deliver a thorough, well-structured, accurately cited answer to the user's request.",
  "Your specialist research goblins are your tools, and they are your only access to the live web and the user's documents — you cannot search or browse directly. Delegating to a goblin is how you search.",
  "Work in delegation ROUNDS: pick the goblins that fit the question and dispatch them in ONE parallel batch, then wait for their briefs. After each round decide: if the briefs cover the question, stop and write the answer; only run another round to close a specific, named gap. When you delegate again, fill each goblin's knownFindings field with what is already established and which URLs are covered so no work is repeated.",
  "A brief may begin with GOBLIN_ERROR — treat that as a missing source: either re-delegate that task once (to the same or a better-suited goblin) or proceed and name the gap in your answer.",
  "Write the final answer yourself, synthesized across the briefs rather than relaying any single goblin's text. Treat the goblins' sourced findings and the current date as authoritative reflections of the present; build on them instead of second-guessing or declining. If the evidence is thin, give what was found and name the gaps.",
  "You are done when the answer is grounded in the goblins' evidence, cites those sources inline, mirrors the user's exact terminology, and directly resolves the request.",
].join(" ")

const MANAGER_EVALUATOR_INSTRUCTION =
  "Before writing the final answer, call coverage_check once with the user's question and a bullet summary of your findings; if it returns gaps, close at most the most important ones with one final round, then write."

export function buildManagerBudgetLine(triage: GoblinsTriageResult): string {
  const { tier, suggestedGoblins } = triage
  const suggestion =
    suggestedGoblins && suggestedGoblins.length > 0
      ? ` Likely useful specialists: ${suggestedGoblins.join(", ")}.`
      : ""
  return `Budget for this request: at most ${String(tier.maxDelegationRounds)} delegation round(s), about ${String(tier.maxGoblinsPerRound)} goblins per round. Finishing under budget is good.${suggestion}`
}

const coverageCheckInputSchema = z.object({
  question: z.string().describe("The user's question, verbatim."),
  findingsSummary: z
    .string()
    .describe("Bullet summary of the findings gathered so far."),
})

const coverageCheckOutputSchema = z.object({
  verdict: z.enum(["complete", "gaps"]),
  gaps: z.array(z.string()).max(3),
})

const COVERAGE_CHECK_INSTRUCTION = [
  "You judge whether gathered research findings fully answer a question.",
  "Return verdict 'complete' when the findings settle every part of the question, or 'gaps' with at most three concrete, closable gaps (missing entity, unverified number, uncovered time period).",
  "Judge coverage only — never answer the question yourself.",
].join(" ")

// Cheap pre-synthesis judge, attached to the manager only on evaluator-enabled
// tiers. Any failure returns "complete" so the check can never block synthesis.
export function createCoverageCheckTool(params: {
  requestId?: string
  signal?: AbortSignal
  onPhaseEvent: (event: AgentStreamEvent) => void
}): Tool {
  return tool({
    name: "coverage_check",
    description:
      "Judges whether the gathered findings fully answer the user's question. Call once before writing the final answer.",
    parameters: coverageCheckInputSchema,
    execute: async ({ question, findingsSummary }) => {
      params.onPhaseEvent({
        type: "goblins_phase",
        phase: "evaluate",
        label: "Checking coverage",
      })
      try {
        const judge = new Agent({
          name: "goblins-evaluator",
          instructions: COVERAGE_CHECK_INSTRUCTION,
          model: AvailableModels.OPENAI_GPT_5_4_MINI,
          modelSettings: {
            reasoning: { effort: "low" },
            providerData: { prompt_cache_key: "goblins-evaluator" },
          },
          outputType: coverageCheckOutputSchema,
        })
        const result = await run(
          judge,
          `Question:\n${question}\n\nFindings:\n${findingsSummary}`,
          { maxTurns: 1, signal: params.signal }
        )
        const parsed = coverageCheckOutputSchema.safeParse(result.finalOutput)
        if (parsed.success) {
          return JSON.stringify(parsed.data)
        }
      } catch (error) {
        logger.warn("coverage_check failed; reporting complete.", {
          requestId: params.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return JSON.stringify({ verdict: "complete", gaps: [] })
    },
  })
}

export async function* startGoblinsRuntimeStream(
  params: StartGoblinsRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const inputItems = toAgentInputItems(params.messages)
  if (inputItems.length === 0) {
    return
  }

  configureOpenAiForAgents(params.openAiApiKey)
  configureResponsesTransport(
    params.featureFlags?.responsesWebsocketTransport ?? false
  )

  // Adaptive orchestration (flag-gated): a cheap triage pass picks the budget
  // tier that drives every knob below. Flag off → the legacy single-round flow
  // with byte-identical prompts.
  const adaptiveEnabled = params.featureFlags?.goblinsAdaptive ?? false
  const triage: GoblinsTriageResult | null = adaptiveEnabled
    ? await classifyGoblinsQuery({
        openAiApiKey: params.openAiApiKey,
        messages: params.messages,
        requestId: params.requestId,
        signal: params.signal,
      })
    : null
  const tier: GoblinsBudgetTier = triage?.tier ?? GOBLINS_BUDGET_TIERS.standard

  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  // The goblins do the actual web searching (their Exa calls) inside their own
  // sub-agent runs. They forward their already-mapped search activity + sources
  // here so the user sees the "Searching the web" steps and citations, not just
  // the final answer. We dedupe sources by URL across goblins before surfacing.
  const nestedEventBuffer: AgentStreamEvent[] = []
  const seenSourceUrls = new Set<string>()
  // Track forwarded goblin search calls so we can balance any that end without a
  // result (a goblin can stop on its step cap with a search still pending). Left
  // unbalanced, the route appends a spurious "tool request started" note.
  const openToolCallIds = new Set<string>()
  const hostedToolsEnabled = params.featureFlags?.goblinsHostedTools ?? false

  const goblinTools = createGoblinTools({
    openAiApiKey: params.openAiApiKey,
    exaApiKey: params.exaApiKey,
    signal: params.signal,
    ...(adaptiveEnabled
      ? {
          adaptive: {
            tier,
            sharedResearch: createSharedResearchState(),
          },
        }
      : {}),
    ...(hostedToolsEnabled
      ? { hosted: { vectorStoreIds: params.vectorStoreIds } }
      : {}),
    onSubEvent: (event) => {
      if (event.type === "source") {
        if (seenSourceUrls.has(event.source.url)) {
          return
        }
        seenSourceUrls.add(event.source.url)
      } else if (event.type === "tool_call" && event.callId) {
        openToolCallIds.add(event.callId)
      } else if (event.type === "tool_result" && event.callId) {
        openToolCallIds.delete(event.callId)
      }
      nestedEventBuffer.push(event)
    },
  })

  const drainNestedEvents = function* (): Generator<AgentStreamEvent> {
    while (nestedEventBuffer.length > 0) {
      const event = nestedEventBuffer.shift()
      if (event) {
        yield event
      }
    }
  }

  const finalizeOpenGoblinToolCalls =
    function* (): Generator<AgentStreamEvent> {
      for (const callId of openToolCallIds) {
        yield { type: "tool_result", callId, status: "success" }
      }
      openToolCallIds.clear()
    }

  // Evaluator-enabled tiers get the coverage_check judge; its phase event rides
  // the same nested buffer as goblin activity.
  const managerTools: Tool[] =
    adaptiveEnabled && tier.evaluatorEnabled
      ? [
          ...goblinTools,
          createCoverageCheckTool({
            requestId: params.requestId,
            signal: params.signal,
            onPhaseEvent: (event) => {
              nestedEventBuffer.push(event)
            },
          }),
        ]
      : goblinTools

  const managerInstructions = adaptiveEnabled
    ? [
        params.systemInstruction,
        tier.evaluatorEnabled
          ? `${MANAGER_ORCHESTRATION_INSTRUCTION_V2} ${MANAGER_EVALUATOR_INSTRUCTION}`
          : MANAGER_ORCHESTRATION_INSTRUCTION_V2,
        // Volatile per-request budget line last: params.systemInstruction already
        // ends with volatile blocks, so this placement costs no cache reuse.
        buildManagerBudgetLine(triage ?? { tier, source: "fallback" }),
      ].join("\n\n")
    : `${params.systemInstruction}\n\n${MANAGER_ORCHESTRATION_INSTRUCTION}`

  const managerReasoningEffort = adaptiveEnabled
    ? tier.managerReasoningEffort
    : "xhigh"

  const manager = new Agent({
    // The single-model MID_BUDGET reminder ("limited web-tool budget; prefer
    // synthesizing over retrievals; stop calling tools") is deliberately NOT
    // applied here — for the manager, "tools" are the goblins, so that guidance
    // suppresses delegation and makes it wrongly claim web search is unavailable.
    name: "goblins-manager",
    instructions: managerInstructions,
    model: GOBLINS_MANAGER_MODEL,
    modelSettings: {
      reasoning: { effort: managerReasoningEffort, summary: "auto" },
      // Goblins is a deep-research mode — the final answer should be thorough.
      text: { verbosity: "high" },
      // Let the manager fire its goblin batch as concurrent tool calls (matches
      // the "single parallel batch" instruction) so the fan-out runs in parallel
      // rather than one goblin at a time.
      parallelToolCalls: true,
      // Manager is GPT-5.5 → 24h cache retention; the stable orchestration
      // prefix is reused across requests via this dedicated cache key.
      promptCacheRetention: "24h",
      providerData: { prompt_cache_key: GOBLINS_MANAGER_CACHE_KEY },
      // The manager accumulates every goblin's brief, so it benefits most from
      // server-side compaction when that flag is on.
      ...resolveContextManagementSettings(
        params.featureFlags?.responseCompaction ?? false
      ),
    },
    tools: managerTools,
  })

  logger.info("Starting goblins runtime stream.", {
    requestId: params.requestId,
    managerModel: GOBLINS_MANAGER_MODEL,
    goblinCount: goblinTools.length,
    ...(adaptiveEnabled ? { tier: tier.id, triageSource: triage?.source } : {}),
  })

  if (adaptiveEnabled && triage) {
    yield {
      type: "goblins_phase",
      phase: "triage",
      tier: tier.id,
      label: "Sizing up the question",
    }
  }

  let hasEmittedText = false
  // Mechanical delegation-round markers: the first subagent_call opens round 1;
  // a subagent_call arriving after any result opens a new round. A parallel
  // batch therefore yields exactly one marker.
  let round = 0
  let resultsSinceMarker = 0

  const result = await run(manager, inputItems, {
    stream: true,
    maxTurns: adaptiveEnabled
      ? tier.managerMaxTurns
      : GOBLINS_MANAGER_MAX_TURNS,
    signal: params.signal,
  })

  try {
    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        for (const mapped of mapper.mapRawModelEvent(event.data)) {
          if (mapped.type === "text_delta") {
            hasEmittedText = true
          }
          yield mapped
        }
      } else if (event.type === "run_item_stream_event") {
        for (const mapped of mapper.mapRunItemEvent(event.name, event.item)) {
          if (adaptiveEnabled && mapped.type === "subagent_call") {
            if (round === 0 || resultsSinceMarker > 0) {
              round += 1
              resultsSinceMarker = 0
              yield {
                type: "goblins_phase",
                phase: "round",
                round,
                label:
                  round === 1
                    ? "Research round 1"
                    : `Research round ${String(round)} — filling gaps`,
              }
            }
          } else if (adaptiveEnabled && mapped.type === "subagent_result") {
            resultsSinceMarker += 1
          }
          yield mapped
        }
      }
      yield* drainNestedEvents()
    }

    await result.completed
    yield* drainNestedEvents()
    logger.info("Goblins runtime stream finished.", {
      requestId: params.requestId,
      hasEmittedText,
      // Manager-only usage; each goblin logs its own usage from its
      // startAgentRuntimeStream run.
      usage: summarizeRunUsage(result.state.usage),
    })
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      logger.warn("Goblins manager hit max turns; running final synthesis.", {
        requestId: params.requestId,
      })
    } else {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error)
      throw new Error(`Goblins manager stream error: ${message}`)
    }
  }

  for (const mapped of mapper.flushReasoning()) {
    yield mapped
  }
  yield* drainNestedEvents()
  yield* finalizeOpenGoblinToolCalls()

  // Forced final-synthesis safety net: the manager may end on a goblin tool turn
  // without writing the answer. Re-run GPT-5.5 with the gathered history (which
  // includes every goblin brief), no tools, and a hard instruction to synthesize.
  if (!hasEmittedText && !params.signal?.aborted) {
    try {
      const history =
        (result.history as AgentInputItem[] | undefined) ?? inputItems
      const synthesisAgent = new Agent({
        name: "goblins-manager-synthesis",
        instructions: `${params.systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
        model: GOBLINS_MANAGER_MODEL,
        modelSettings: {
          reasoning: { effort: managerReasoningEffort, summary: "auto" },
          text: { verbosity: "high" },
          promptCacheRetention: "24h",
          providerData: { prompt_cache_key: GOBLINS_MANAGER_CACHE_KEY },
        },
      })

      logger.warn("Goblins manager emitted no text; running synthesis.", {
        requestId: params.requestId,
        historyItemCount: history.length,
      })

      const synthesisInput: AgentInputItem[] = [
        ...history,
        { role: "user", content: FINAL_SYNTHESIS_USER_PROMPT },
      ]
      const synthesisResult = await run(synthesisAgent, synthesisInput, {
        stream: true,
        maxTurns: 1,
        signal: params.signal,
      })

      let fallbackEmittedText = false
      for await (const event of synthesisResult) {
        if (event.type !== "raw_model_stream_event") {
          continue
        }
        const delta = readTextDelta(event.data)
        if (delta && delta.length > 0) {
          hasEmittedText = true
          fallbackEmittedText = true
          yield { type: "text_delta", delta }
        }
      }
      await synthesisResult.completed

      if (!fallbackEmittedText) {
        logger.warn("Goblins synthesis completed without emitting text.", {
          requestId: params.requestId,
        })
      }
    } catch (fallbackError) {
      logger.warn("Goblins synthesis failed; yielding nothing.", {
        requestId: params.requestId,
        error: fallbackError,
      })
    }
  }
}
