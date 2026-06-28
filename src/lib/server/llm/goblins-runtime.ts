import {
  Agent,
  type AgentInputItem,
  MaxTurnsExceededError,
  run,
} from "@openai/agents"

import { createLogger } from "@/lib/logger"
import { GOBLINS_MANAGER_MAX_TURNS } from "@/lib/server/agent-runtime-config"
import { type AgentStreamEvent, GOBLINS_MANAGER_MODEL } from "@/lib/shared"

import {
  FINAL_SYNTHESIS_STEP_INSTRUCTION,
  FINAL_SYNTHESIS_USER_PROMPT,
  type StartAgentRuntimeStreamParams,
} from "./agent-runtime"
import { toAgentInputItems } from "./agent-runtime-messages"
import { createAgentStreamMapper, readTextDelta } from "./agent-stream-mapping"
import { createGoblinTools, resolveGoblinSubagent } from "./goblins-agents"
import { configureOpenAiForAgents } from "./openai-client"

const logger = createLogger("goblins-runtime")

// "Goblins" mode reuses the single-model params shape so the gateway branch is a
// drop-in. params.model is always "goblins"; the real models are fixed here
// (manager = GPT-5.5, sub-agents = gpt-5.4-mini), all at xhigh reasoning.
export type StartGoblinsRuntimeStreamParams = StartAgentRuntimeStreamParams

const MANAGER_ORCHESTRATION_INSTRUCTION = [
  "You are the lead analyst. Goal: deliver a thorough, well-structured, accurately cited answer to the user's request.",
  "Your specialist research goblins are your tools, and they are your only access to the live web — you cannot search or browse directly. So when the answer depends on current, external, or uncertain information, delegate to the relevant goblins to gather evidence; calling a goblin is how you search the web.",
  "Pick the goblins that fit the question (usually two to four) and dispatch them in ONE parallel batch, then wait for their briefs. Treat this as a single delegation round: reconcile what comes back and write the answer — do not spawn repeated rounds chasing more sources. Only delegate again if a brief reveals a specific, essential gap.",
  "Write the final answer yourself, synthesized across the briefs rather than relaying any single goblin's text. Treat the goblins' sourced findings and the current date as authoritative reflections of the present; build on them instead of second-guessing or declining. If the evidence is thin, give what was found and name the gaps.",
  "You are done when the answer is grounded in the goblins' evidence, cites those sources inline, mirrors the user's exact terminology, and directly resolves the request.",
].join(" ")

export async function* startGoblinsRuntimeStream(
  params: StartGoblinsRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const inputItems = toAgentInputItems(params.messages)
  if (inputItems.length === 0) {
    return
  }

  configureOpenAiForAgents(params.openAiApiKey)

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
  const goblinTools = createGoblinTools({
    openAiApiKey: params.openAiApiKey,
    exaApiKey: params.exaApiKey,
    signal: params.signal,
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

  const finalizeOpenGoblinToolCalls = function* (): Generator<AgentStreamEvent> {
    for (const callId of openToolCallIds) {
      yield { type: "tool_result", callId, status: "success" }
    }
    openToolCallIds.clear()
  }

  const manager = new Agent({
    // The single-model MID_BUDGET reminder ("limited web-tool budget; prefer
    // synthesizing over retrievals; stop calling tools") is deliberately NOT
    // applied here — for the manager, "tools" are the goblins, so that guidance
    // suppresses delegation and makes it wrongly claim web search is unavailable.
    name: "goblins-manager",
    instructions: `${params.systemInstruction}\n\n${MANAGER_ORCHESTRATION_INSTRUCTION}`,
    model: GOBLINS_MANAGER_MODEL,
    modelSettings: {
      reasoning: { effort: "xhigh", summary: "auto" },
      // Goblins is a deep-research mode — the final answer should be thorough.
      text: { verbosity: "high" },
      // Let the manager fire its goblin batch as concurrent tool calls (matches
      // the "single parallel batch" instruction) so the fan-out runs in parallel
      // rather than one goblin at a time.
      parallelToolCalls: true,
    },
    tools: goblinTools,
  })

  logger.info("Starting goblins runtime stream.", {
    requestId: params.requestId,
    managerModel: GOBLINS_MANAGER_MODEL,
    goblinCount: goblinTools.length,
  })

  let hasEmittedText = false

  const result = await run(manager, inputItems, {
    stream: true,
    maxTurns: GOBLINS_MANAGER_MAX_TURNS,
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
          reasoning: { effort: "xhigh", summary: "auto" },
          text: { verbosity: "high" },
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
