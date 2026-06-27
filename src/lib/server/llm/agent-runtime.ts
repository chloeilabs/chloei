import {
  Agent,
  type AgentInputItem,
  MaxTurnsExceededError,
  run,
} from "@openai/agents"

import { asRecord, asString } from "@/lib/cast"
import { createLogger } from "@/lib/logger"
import { AGENT_TOOL_MAX_STEPS } from "@/lib/server/agent-runtime-config"
import { type AgentFeatureFlags } from "@/lib/server/integration-flags"
import { type AgentStreamEvent, type ModelType } from "@/lib/shared"

import {
  type AgentInputMessage,
  toModelMessages,
} from "./agent-runtime-messages"
import { createReasoningDisplaySanitizer } from "./initial-reasoning-chunk-sanitizer"
import {
  createOpenAiAgentsExaTools,
  getExaToolCallMetadata,
  getExaToolResultMetadata,
  isExaToolName,
} from "./openai-agents-exa-tools"
import { configureOpenAiForAgents } from "./openai-client"

const logger = createLogger("agent-runtime")

const REASONING_EFFORT = "high" as const

type UserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string }
  | { type: "input_file"; file: string; filename: string }

export interface StartAgentRuntimeStreamParams {
  requestId?: string
  model: ModelType
  openAiApiKey: string
  exaApiKey?: string
  userTimeZone?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  temperature?: number
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

const FINAL_SYNTHESIS_STEP_INSTRUCTION = [
  "You are on the final synthesis step for this request.",
  "Do not call any tools on this step.",
  "You MUST write a final answer now using the tool results and sources already gathered.",
  "An empty response is not acceptable. If evidence is incomplete or contradictory, write what you found, name the missing pieces, and end with a clear summary.",
  "Mirror the user's exact terminology — if they asked about operating margin, CET1, net interest income, cash flow from operations, or any named metric, use those exact phrases in your answer.",
  "Cite the sources you used inline. Do not stall, do not stay silent, and do not ask the user to retry.",
].join(" ")

const FINAL_SYNTHESIS_USER_PROMPT =
  "Now write the final answer to my original question using the tool results above. Mirror my exact terminology. Do not call any tools. An empty response is not acceptable — if the evidence is partial, write what you found and name the gap."

function getSourceEvent(
  id: string,
  url: string,
  title: string
): Extract<AgentStreamEvent, { type: "source" }> {
  return {
    type: "source",
    source: {
      id,
      url,
      title,
    },
  }
}

function shouldSkipReasoningChunk(text: string): boolean {
  return text.trim() === "[REDACTED]"
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value
}

function normalizeToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

// The Agents SDK emits NORMALIZED raw-model events: assistant text arrives as
// { type: "output_text_delta", delta }. Reasoning summaries have no normalized
// event, so they come via the raw passthrough { type: "model", event: <OpenAI
// Responses event> } as response.reasoning_summary_text.delta.
function readTextDelta(eventData: unknown): string | null {
  const data = asRecord(eventData)
  if (asString(data?.type) === "output_text_delta") {
    return asString(data?.delta) ?? ""
  }
  return null
}

function readReasoningDelta(eventData: unknown): string | null {
  const data = asRecord(eventData)
  if (asString(data?.type) !== "model") {
    return null
  }
  const raw = asRecord(data?.event)
  const rawType = asString(raw?.type)
  if (
    rawType === "response.reasoning_summary_text.delta" ||
    rawType === "response.reasoning_text.delta"
  ) {
    return asString(raw?.delta) ?? ""
  }
  return null
}

function buildInstructions(systemInstruction: string): string {
  return `${systemInstruction}\n\n${MID_BUDGET_SYNTHESIS_REMINDER}`
}

export async function* startAgentRuntimeStream(
  params: StartAgentRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  // Convert to Agents SDK input items. User content may be a plain string, but
  // assistant history items require a content array of output_text parts (a
  // plain string throws "item.content.map is not a function" on multi-turn).
  // User messages with attachments become a multimodal content array
  // (input_text + input_image / input_file) for vision / PDF analysis.
  const inputItems = toModelMessages(params.messages).map(
    (message): AgentInputItem => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: message.content }],
        }
      }

      const attachments = message.attachments ?? []
      if (attachments.length === 0) {
        return { role: "user", content: message.content }
      }

      const content: UserContentPart[] = []
      if (message.content) {
        content.push({ type: "input_text", text: message.content })
      }
      for (const attachment of attachments) {
        if (!attachment.url) {
          continue
        }
        content.push(
          attachment.kind === "image"
            ? { type: "input_image", image: attachment.url }
            : {
                type: "input_file",
                file: attachment.url,
                filename: attachment.name,
              }
        )
      }
      return { role: "user", content }
    }
  )
  if (inputItems.length === 0) {
    return
  }

  configureOpenAiForAgents(params.openAiApiKey)

  const tools = createOpenAiAgentsExaTools(params.exaApiKey?.trim())
  const toolNames = tools.map((tool) => tool.name)

  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()
  const toolNamesByCallId = new Map<string, string>()
  const sanitizeReasoningChunk = createReasoningDisplaySanitizer()

  const createSourceEvent = (
    id: string,
    url: string,
    title: string
  ): Extract<AgentStreamEvent, { type: "source" }> | null => {
    const normalizedUrl = url.trim()
    const normalizedTitle = title.trim() || normalizedUrl
    if (!normalizedUrl || seenSourceKeys.has(normalizedUrl)) {
      return null
    }

    seenSourceKeys.add(normalizedUrl)
    return getSourceEvent(id, normalizedUrl, normalizedTitle)
  }

  const agent = new Agent({
    name: "chloei-agent",
    instructions: buildInstructions(params.systemInstruction),
    model: params.model,
    modelSettings: {
      reasoning: { effort: REASONING_EFFORT, summary: "auto" },
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
    maxTurns: AGENT_TOOL_MAX_STEPS,
    signal: params.signal,
  })

  try {
    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        const reasoningDelta = readReasoningDelta(event.data)
        if (reasoningDelta !== null) {
          const delta = sanitizeReasoningChunk(reasoningDelta)
          if (delta.length > 0 && !shouldSkipReasoningChunk(delta)) {
            yield { type: "reasoning_delta", delta }
          }
          continue
        }

        const textDelta = readTextDelta(event.data)
        if (textDelta && textDelta.length > 0) {
          hasEmittedText = true
          yield { type: "text_delta", delta: textDelta }
        }
        continue
      }

      if (event.type === "run_item_stream_event") {
        const item = asRecord(event.item)
        const rawItem = asRecord(item?.rawItem)

        if (event.name === "tool_called") {
          const callId = asString(rawItem?.callId)
          const toolName = asString(rawItem?.name)
          if (!callId || !toolName) {
            continue
          }
          toolNamesByCallId.set(callId, toolName)

          const metadata = getExaToolCallMetadata({
            toolCallId: callId,
            toolName,
            input: parseToolArguments(rawItem?.arguments),
          })
          if (!metadata || seenToolCalls.has(metadata.callId)) {
            continue
          }

          seenToolCalls.add(metadata.callId)
          yield {
            type: "tool_call",
            callId: metadata.callId,
            toolName: metadata.toolName,
            label: metadata.label,
            ...(metadata.query ? { query: metadata.query } : {}),
            ...(metadata.operation ? { operation: metadata.operation } : {}),
            ...(metadata.provider ? { provider: metadata.provider } : {}),
          }
          continue
        }

        if (event.name === "tool_output") {
          const callId = asString(rawItem?.callId)
          const toolName =
            asString(rawItem?.name) ??
            (callId ? toolNamesByCallId.get(callId) : undefined)
          if (!callId || !toolName || !isExaToolName(toolName)) {
            continue
          }
          if (finalizedToolCalls.has(callId)) {
            continue
          }

          const normalizedOutput = normalizeToolOutput(item?.output)

          // The SDK returns a plain string (not our {output|error} payload) when
          // the model sent invalid tool-call arguments and execute never ran
          // (InvalidToolInputError). Surface it as a clean, retryable error.
          if (!asRecord(normalizedOutput)) {
            finalizedToolCalls.add(callId)
            yield {
              type: "tool_result",
              callId,
              toolName,
              status: "error",
              operation: toolName === "exa_search" ? "search" : "get_contents",
              provider: "exa",
              errorCode: "TOOL_INPUT_ERROR",
              retryable: true,
            }
            continue
          }

          const metadata = getExaToolResultMetadata({
            toolCallId: callId,
            toolName,
            output: normalizedOutput,
          })
          if (!metadata) {
            continue
          }

          finalizedToolCalls.add(metadata.callId)
          yield {
            type: "tool_result",
            callId: metadata.callId,
            toolName: metadata.toolName,
            status: metadata.status,
            ...(metadata.operation ? { operation: metadata.operation } : {}),
            ...(metadata.provider ? { provider: metadata.provider } : {}),
            ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
            ...(metadata.retryable !== undefined
              ? { retryable: metadata.retryable }
              : {}),
          }

          for (const source of metadata.sources) {
            const sourceEvent = createSourceEvent(
              source.id,
              source.url,
              source.title
            )
            if (sourceEvent) {
              yield sourceEvent
            }
          }
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

  const finalReasoningDelta = sanitizeReasoningChunk.flush()
  if (
    finalReasoningDelta.length > 0 &&
    !shouldSkipReasoningChunk(finalReasoningDelta)
  ) {
    yield { type: "reasoning_delta", delta: finalReasoningDelta }
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
          reasoning: { effort: REASONING_EFFORT, summary: "auto" },
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
