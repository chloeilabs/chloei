import {
  Agent,
  type AgentInputItem,
  MaxTurnsExceededError,
  run,
} from "@openai/agents"

import { createLogger } from "@/lib/logger"
import { AGENT_TOOL_MAX_STEPS } from "@/lib/server/agent-runtime-config"
import { type AgentFeatureFlags } from "@/lib/server/integration-flags"
import {
  type AgentStreamEvent,
  AvailableModels,
  type ModelType,
} from "@/lib/shared"

import {
  type AgentInputMessage,
  toAgentInputItems,
} from "./agent-runtime-messages"
import { createAgentStreamMapper, readTextDelta } from "./agent-stream-mapping"
import { createOpenAiAgentsExaTools } from "./openai-agents-exa-tools"
import {
  configureOpenAiForAgents,
  configureResponsesTransport,
} from "./openai-client"

const logger = createLogger("agent-runtime")

export type ReasoningEffortLevel = "high" | "xhigh"

// GPT-5.5 runs at xhigh reasoning effort; other models default to high. Callers
// (e.g. the Goblins sub-agents) may force a level via reasoningEffort.
const resolveReasoningEffort = (
  model: ModelType,
  override?: ReasoningEffortLevel
): ReasoningEffortLevel =>
  override ?? (model === AvailableModels.OPENAI_GPT_5_5 ? "xhigh" : "high")

export interface StartAgentRuntimeStreamParams {
  requestId?: string
  model: ModelType
  openAiApiKey: string
  exaApiKey?: string
  userTimeZone?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  temperature?: number
  reasoningEffort?: ReasoningEffortLevel
  // Overrides the tool-step budget (default AGENT_TOOL_MAX_STEPS). The forced
  // final-synthesis fallback still fires on overrun, so a small value keeps a
  // sub-agent fast while still producing a written answer from what it gathered.
  maxToolSteps?: number
  signal?: AbortSignal
  userId?: string
  featureFlags?: AgentFeatureFlags
}

// Baked into every run's instructions. The OpenAI Agents SDK has no per-step
// system override (unlike the AI SDK's prepareStep), so the mid-budget nudge is
// always-on guidance; the forced final-synthesis pass below is the real safety
// net for silent, tool-only completions.
const MID_BUDGET_SYNTHESIS_REMINDER = [
  "You have a limited web-tool budget for each request (about a dozen tool calls).",
  "Prefer synthesizing the final answer from the evidence you have over running deeper retrievals.",
  "If another tool call would not materially change the conclusion, stop calling tools and write the answer.",
  "Always finish by writing the user-facing answer; mirror the user's exact terminology (named metrics, defined terms, proper nouns) rather than paraphrasing.",
].join(" ")

export const FINAL_SYNTHESIS_STEP_INSTRUCTION = [
  "You are on the final synthesis step for this request.",
  "Do not call any tools on this step.",
  "You MUST write a final answer now using the tool results and sources already gathered.",
  "An empty response is not acceptable. If evidence is incomplete or contradictory, write what you found, name the missing pieces, and end with a clear summary.",
  "Mirror the user's exact terminology — if they asked about operating margin, CET1, net interest income, cash flow from operations, or any named metric, use those exact phrases in your answer.",
  "Cite the sources you used inline. Do not stall, do not stay silent, and do not ask the user to retry.",
].join(" ")

export const FINAL_SYNTHESIS_USER_PROMPT =
  "Now write the final answer to my original question using the tool results above. Mirror my exact terminology. Do not call any tools. An empty response is not acceptable — if the evidence is partial, write what you found and name the gap."

export function buildInstructions(systemInstruction: string): string {
  return `${systemInstruction}\n\n${MID_BUDGET_SYNTHESIS_REMINDER}`
}

export async function* startAgentRuntimeStream(
  params: StartAgentRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const inputItems = toAgentInputItems(params.messages)
  if (inputItems.length === 0) {
    return
  }

  configureOpenAiForAgents(params.openAiApiKey)
  configureResponsesTransport(
    params.featureFlags?.responsesWebsocketTransport ?? false
  )

  const tools = createOpenAiAgentsExaTools(params.exaApiKey?.trim())
  const toolNames = tools.map((tool) => tool.name)

  const mapper = createAgentStreamMapper()

  const agent = new Agent({
    name: "chloei-agent",
    instructions: buildInstructions(params.systemInstruction),
    model: params.model,
    modelSettings: {
      reasoning: {
        effort: resolveReasoningEffort(params.model, params.reasoningEffort),
        summary: "auto",
      },
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
    },
    tools,
  })

  logger.info("Starting agent runtime stream.", {
    requestId: params.requestId,
    model: params.model,
    toolCount: toolNames.length,
    toolNames,
  })

  let hasEmittedText = false

  const result = await run(agent, inputItems, {
    stream: true,
    maxTurns: params.maxToolSteps ?? AGENT_TOOL_MAX_STEPS,
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
        continue
      }

      if (event.type === "run_item_stream_event") {
        for (const mapped of mapper.mapRunItemEvent(event.name, event.item)) {
          yield mapped
        }
        continue
      }
    }

    await result.completed
    logger.info("Agent runtime stream finished.", {
      requestId: params.requestId,
      model: params.model,
      hasEmittedText,
    })
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      logger.warn("Agent runtime hit max turns; running final synthesis.", {
        requestId: params.requestId,
        model: params.model,
      })
    } else {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error)
      throw new Error(`Agent model stream error: ${message}`)
    }
  }

  for (const mapped of mapper.flushReasoning()) {
    yield mapped
  }

  // Forced final-synthesis safety net: if the run finished (or hit the turn cap)
  // without writing any text, re-run with the gathered history, no tools, and a
  // hard instruction to write the answer now. Replaces the AI SDK prepareStep
  // forced-synthesis step + empty-response fallback.
  if (!hasEmittedText && !params.signal?.aborted) {
    try {
      const history =
        (result.history as AgentInputItem[] | undefined) ?? inputItems
      const synthesisAgent = new Agent({
        name: "chloei-agent-synthesis",
        instructions: `${params.systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
        model: params.model,
        modelSettings: {
          reasoning: {
            effort: resolveReasoningEffort(
              params.model,
              params.reasoningEffort
            ),
            summary: "auto",
          },
          ...(params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
        },
      })

      logger.warn("Main run emitted no text; running synthesis fallback.", {
        requestId: params.requestId,
        model: params.model,
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
        logger.warn("Synthesis fallback completed without emitting text.", {
          requestId: params.requestId,
          model: params.model,
        })
      }
    } catch (fallbackError) {
      logger.warn("Synthesis fallback failed; yielding nothing.", {
        requestId: params.requestId,
        model: params.model,
        error: fallbackError,
      })
    }
  }
}
