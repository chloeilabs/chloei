import { createGateway } from "@ai-sdk/gateway"
import {
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai"

import { createLogger } from "@/lib/logger"
import {
  type PromptTaskMode,
  resolvePromptProvider,
} from "@/lib/server/agent-prompt-steering"
import { AGENT_TOOL_MAX_STEPS } from "@/lib/server/agent-runtime-config"
import {
  type AgentFeatureFlags,
  getDefaultAgentFeatureFlags,
} from "@/lib/server/integration-flags"
import { hashUserId } from "@/lib/server/privacy"
import { type AgentStreamEvent, type ModelType } from "@/lib/shared"

import {
  type AgentInputMessage,
  toModelMessages,
} from "./agent-runtime-messages"
import {
  shouldForceFinalSynthesisStep,
  shouldNudgeMidBudgetSynthesis,
} from "./agent-runtime-synthesis-gating"
import { getAiSdkGatewayProviderOptionsForTaskMode } from "./ai-sdk-gateway-provider-options"
import {
  createAiSdkTavilyTools,
  getAiSdkTavilyToolCallMetadata,
  getAiSdkTavilyToolResultMetadata,
  isAiSdkTavilyToolName,
} from "./ai-sdk-tavily-tools"
import {
  createAiSdkCodeExecutionTools,
  getAiSdkCodeExecutionToolCallMetadata,
  getAiSdkCodeExecutionToolResultMetadata,
  isAiSdkCodeExecutionToolName,
} from "./code-execution-tools"
import { aiGatewayFetch } from "./gateway-client"
import { createReasoningDisplaySanitizer } from "./initial-reasoning-chunk-sanitizer"

const logger = createLogger("agent-runtime")

export interface StartAgentRuntimeStreamParams {
  requestId?: string
  model: ModelType
  aiGatewayApiKey: string
  tavilyApiKey?: string
  userTimeZone?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  taskMode: PromptTaskMode
  temperature?: number
  signal?: AbortSignal
  userId?: string
  featureFlags?: AgentFeatureFlags
}

const FINAL_SYNTHESIS_STEP_INSTRUCTION = [
  "You are on the final synthesis step for this request.",
  "Do not call any tools on this step.",
  "You MUST write a final answer now using the tool results and sources already gathered.",
  "An empty response is not acceptable. If evidence is incomplete or contradictory, write what you found, name the missing pieces, and end with a clear summary.",
  "Mirror the user's exact terminology — if they asked about operating margin, CET1, net interest income, cash flow from operations, or any named metric, use those exact phrases in your answer.",
  "Cite the sources you used inline. Do not stall, do not stay silent, and do not ask the user to retry.",
].join(" ")

const MID_BUDGET_SYNTHESIS_REMINDER = [
  "Tool-budget checkpoint: most of your tool-call budget for this request is already spent.",
  "Prefer synthesizing the final answer from the evidence you have over running deeper retrievals.",
  "If another tool call would not materially change the conclusion, stop calling tools and write the answer.",
  "When you write the answer, mirror the user's exact terminology (e.g., 'operating margin', 'CET1', 'net interest income') rather than paraphrasing.",
].join(" ")

const EMPTY_RESPONSE_SYNTHESIS_FALLBACK_SYSTEM = [
  "Your previous turn finished without writing a final answer to the user.",
  "Look at the tool results and any retrieved evidence in the conversation above, and write the answer now using only that evidence.",
  "Do not call any tools.",
  "Mirror the user's exact terminology in your answer (named metrics, defined terms, proper nouns).",
  "If the evidence is incomplete or contradictory, write what you found, name the gap, and end with a clear summary.",
  "An empty response is not acceptable.",
].join(" ")

// When the main stream finishes mid-tool-call (e.g. abort or provider hiccup),
// response.messages can include assistant tool-call parts that never received
// a matching tool-result message. Sending that history straight to streamText
// raises AI_MissingToolResultsError. This helper appends synthetic stub
// tool-result messages for every orphan so the fallback call always parses.
function sanitizeResponseMessagesForFallback<T extends { role: string }>(
  responseMessages: readonly T[]
): T[] {
  const sanitized: T[] = []
  const seenToolResultIds = new Set<string>()
  for (const message of responseMessages) {
    if (
      message.role === "tool" &&
      typeof (message as unknown as { content?: unknown }).content !== "string"
    ) {
      const parts = (
        message as unknown as { content: { toolCallId?: string }[] }
      ).content
      for (const part of parts) {
        if (typeof part.toolCallId === "string") {
          seenToolResultIds.add(part.toolCallId)
        }
      }
    }
  }

  const orphanCalls: { toolCallId: string; toolName: string }[] = []
  for (const message of responseMessages) {
    sanitized.push(message)
    if (
      message.role !== "assistant" ||
      typeof (message as unknown as { content?: unknown }).content === "string"
    ) {
      continue
    }
    const parts = (
      message as unknown as {
        content: { type?: string; toolCallId?: string; toolName?: string }[]
      }
    ).content
    for (const part of parts) {
      if (
        part.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string" &&
        !seenToolResultIds.has(part.toolCallId)
      ) {
        orphanCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        })
        seenToolResultIds.add(part.toolCallId)
      }
    }
  }

  if (orphanCalls.length === 0) {
    return sanitized
  }

  sanitized.push({
    role: "tool",
    content: orphanCalls.map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: {
        type: "json",
        value: {
          error: "Tool call was not completed before the stream ended.",
          errorCode: "TOOL_CALL_NOT_COMPLETED",
        },
      },
    })),
  } as unknown as T)
  return sanitized
}

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

function getUsageLogFields(usage: LanguageModelUsage | undefined) {
  const outputTokenDetails = usage?.outputTokenDetails as
    | Partial<LanguageModelUsage["outputTokenDetails"]>
    | undefined

  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    textTokens: outputTokenDetails?.textTokens,
    reasoningTokens: outputTokenDetails?.reasoningTokens,
  }
}

export async function* startAgentRuntimeStream(
  params: StartAgentRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const userId = params.userId
  const featureFlags = params.featureFlags ?? getDefaultAgentFeatureFlags()
  const gatewayProvider = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })

  const messages = toModelMessages(params.messages)
  if (messages.length === 0) {
    return
  }

  const normalizedTavilyApiKey = params.tavilyApiKey?.trim()

  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()
  const sanitizeReasoningChunk = createReasoningDisplaySanitizer()

  const createSourceEvent = (
    id: string,
    url: string,
    title: string
  ): Extract<AgentStreamEvent, { type: "source" }> | null => {
    const normalizedUrl = url.trim()
    const normalizedTitle = title.trim() || normalizedUrl
    const key = normalizedUrl
    if (!normalizedUrl || seenSourceKeys.has(key)) {
      return null
    }

    seenSourceKeys.add(key)
    return getSourceEvent(id, normalizedUrl, normalizedTitle)
  }

  const tools = {
    ...createAiSdkCodeExecutionTools(),
    ...createAiSdkTavilyTools(normalizedTavilyApiKey),
  } as ToolSet
  const toolNames = Object.keys(tools)

  logger.info("Starting agent runtime stream.", {
    requestId: params.requestId,
    model: params.model,
    toolCount: toolNames.length,
    toolNames,
  })
  const systemInstruction = params.systemInstruction

  const result = streamText({
    model: gatewayProvider(params.model),
    system: systemInstruction,
    messages,
    abortSignal: params.signal,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    providerOptions: getAiSdkGatewayProviderOptionsForTaskMode({
      provider: resolvePromptProvider(params.model),
      taskMode: params.taskMode,
    }),
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: featureFlags.telemetryRecordIo,
      recordOutputs: featureFlags.telemetryRecordIo,
      functionId: "chloei.agent.stream",
      metadata: {
        requestId: params.requestId ?? "",
        modelId: params.model,
        toolNames: toolNames.join(","),
        userHash: userId ? hashUserId(userId) : "",
      },
    },
    tools,
    prepareStep: ({ stepNumber }) => {
      const forceFinalSynthesis = shouldForceFinalSynthesisStep(
        stepNumber,
        AGENT_TOOL_MAX_STEPS
      )
      if (forceFinalSynthesis) {
        return {
          toolChoice: "none" as const,
          system: `${systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
        }
      }

      if (shouldNudgeMidBudgetSynthesis(stepNumber, AGENT_TOOL_MAX_STEPS)) {
        return {
          system: `${systemInstruction}\n\n${MID_BUDGET_SYNTHESIS_REMINDER}`,
        }
      }

      return undefined
    },
    stopWhen: stepCountIs(AGENT_TOOL_MAX_STEPS),
  })

  let hasEmittedText = false

  for await (const part of result.fullStream) {
    if (part.type === "finish-step") {
      logger.info("Agent runtime model step finished.", {
        requestId: params.requestId,
        model: params.model,
        finishReason: part.finishReason,
        rawFinishReason: part.rawFinishReason,
        ...getUsageLogFields(part.usage),
      })
      continue
    }

    if (part.type === "finish") {
      logger.info("Agent runtime stream finished.", {
        requestId: params.requestId,
        model: params.model,
        finishReason: part.finishReason,
        rawFinishReason: part.rawFinishReason,
        ...getUsageLogFields(part.totalUsage),
      })
      continue
    }

    if (part.type === "abort") {
      logger.warn("Agent runtime stream aborted.", {
        requestId: params.requestId,
        model: params.model,
        reason: part.reason,
      })
      continue
    }

    if (part.type === "text-delta") {
      if (part.text.length > 0) {
        hasEmittedText = true
        yield { type: "text_delta", delta: part.text }
      }
      continue
    }

    if (part.type === "reasoning-delta") {
      const delta = sanitizeReasoningChunk(part.text)
      if (delta.length > 0 && !shouldSkipReasoningChunk(delta)) {
        yield { type: "reasoning_delta", delta }
      }
      continue
    }

    if (part.type === "source" && part.sourceType === "url") {
      const sourceEvent = createSourceEvent(
        part.id,
        part.url,
        part.title?.trim() ?? part.url
      )
      if (sourceEvent) {
        yield sourceEvent
      }
      continue
    }

    if (part.type === "tool-call") {
      const metadata =
        getAiSdkCodeExecutionToolCallMetadata(part) ??
        getAiSdkTavilyToolCallMetadata(part)
      if (!metadata || seenToolCalls.has(metadata.callId)) {
        continue
      }

      seenToolCalls.add(metadata.callId)
      yield {
        type: "tool_call",
        callId: metadata.callId,
        toolName: metadata.toolName,
        label: metadata.label,
        ...("query" in metadata && metadata.query
          ? { query: metadata.query }
          : {}),
        ...("operation" in metadata && metadata.operation
          ? { operation: metadata.operation }
          : {}),
        ...("provider" in metadata && metadata.provider
          ? { provider: metadata.provider }
          : {}),
      }
      continue
    }

    if (part.type === "tool-result") {
      if (part.preliminary) {
        continue
      }

      const metadata =
        getAiSdkCodeExecutionToolResultMetadata(part) ??
        getAiSdkTavilyToolResultMetadata(part)
      if (!metadata || finalizedToolCalls.has(metadata.callId)) {
        continue
      }

      finalizedToolCalls.add(metadata.callId)
      yield {
        type: "tool_result",
        callId: metadata.callId,
        toolName: metadata.toolName,
        status: metadata.status,
        ...("operation" in metadata && metadata.operation
          ? { operation: metadata.operation }
          : {}),
        ...("provider" in metadata && metadata.provider
          ? { provider: metadata.provider }
          : {}),
        ...("durationMs" in metadata && metadata.durationMs !== undefined
          ? { durationMs: metadata.durationMs }
          : {}),
        ...("errorCode" in metadata && metadata.errorCode
          ? { errorCode: metadata.errorCode }
          : {}),
        ...("retryable" in metadata && metadata.retryable !== undefined
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

      continue
    }

    if (
      part.type === "tool-error" &&
      (isAiSdkCodeExecutionToolName(part.toolName) ||
        isAiSdkTavilyToolName(part.toolName)) &&
      !finalizedToolCalls.has(part.toolCallId)
    ) {
      finalizedToolCalls.add(part.toolCallId)
      const toolName = part.toolName
      yield {
        type: "tool_result",
        callId: part.toolCallId,
        toolName,
        status: "error",
        errorCode: "TOOL_EXECUTION_ERROR",
        retryable: true,
      }
    }

    if (part.type === "error") {
      const streamError =
        "error" in part ? (part as { error?: unknown }).error : part
      const message =
        streamError instanceof Error
          ? streamError.message
          : typeof streamError === "string"
            ? streamError
            : JSON.stringify(streamError)
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

  // Synthesis-fallback safety net: if the main stream completed without
  // emitting any text (model called tools then stopped silent), re-invoke
  // the model with the tool results in context and force a written answer.
  // This is the most common failure mode on long multi-source retrieval
  // chains where the model exhausts evidence-gathering and forgets to
  // write the synthesis.
  if (!hasEmittedText && !params.signal?.aborted) {
    try {
      const rawResponseMessages = (await result.response).messages
      const responseMessages =
        sanitizeResponseMessagesForFallback(rawResponseMessages)
      logger.warn("Main stream emitted no text; running synthesis fallback.", {
        requestId: params.requestId,
        model: params.model,
        responseMessageCount: responseMessages.length,
        sanitizedToolStubCount:
          responseMessages.length - rawResponseMessages.length,
      })

      const fallbackResult = streamText({
        model: gatewayProvider(params.model),
        system: EMPTY_RESPONSE_SYNTHESIS_FALLBACK_SYSTEM,
        messages: [
          ...messages,
          ...responseMessages,
          {
            role: "user",
            content:
              "Now write the final answer to my original question using the tool results above. Mirror my exact terminology. Do not call any tools. An empty response is not acceptable — if the evidence is partial, write what you found and name the gap.",
          },
        ],
        abortSignal: params.signal,
        ...(params.temperature !== undefined
          ? { temperature: params.temperature }
          : {}),
        providerOptions: getAiSdkGatewayProviderOptionsForTaskMode({
          provider: resolvePromptProvider(params.model),
          taskMode: params.taskMode,
        }),
        tools,
        toolChoice: "none" as const,
        stopWhen: stepCountIs(1),
      })

      let fallbackEmittedText = false
      for await (const part of fallbackResult.fullStream) {
        if (part.type === "text-delta" && part.text.length > 0) {
          hasEmittedText = true
          fallbackEmittedText = true
          yield { type: "text_delta", delta: part.text }
          continue
        }
        if (part.type === "finish") {
          logger.info("Synthesis fallback stream finished.", {
            requestId: params.requestId,
            model: params.model,
            finishReason: part.finishReason,
            fallbackEmittedText,
            ...getUsageLogFields(part.totalUsage),
          })
        }
        if (part.type === "error") {
          const streamError =
            "error" in part ? (part as { error?: unknown }).error : part
          logger.warn("Synthesis fallback stream emitted an error event.", {
            requestId: params.requestId,
            model: params.model,
            error: streamError,
          })
        }
      }

      if (!fallbackEmittedText) {
        logger.warn("Synthesis fallback completed without emitting text.", {
          requestId: params.requestId,
          model: params.model,
          responseMessageCount: responseMessages.length,
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
