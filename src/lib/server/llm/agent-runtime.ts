import { randomUUID } from "node:crypto"
import path from "node:path"

import { createGateway } from "@ai-sdk/gateway"
import {
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai"
import { Agent, type Dispatcher, Dispatcher1Wrapper } from "undici"

import { createLogger } from "@/lib/logger"
import {
  AGENT_EVAL_RESULTS_DIR,
  AGENT_RESEARCH_TOOL_MAX_STEPS,
  AGENT_TOOL_MAX_STEPS,
  AI_GATEWAY_CLIENT_TIMEOUT_MS,
} from "@/lib/server/agent-runtime-config"
import { type AgentStreamEvent, type ModelType } from "@/lib/shared"

import {
  type AgentInputMessage,
  toModelMessages,
} from "./agent-runtime-messages"
import { getCompatibleStepMessages } from "./agent-runtime-step-messages"
import {
  buildToolSynthesisPrompt,
  getSourceBackedPromptQuery,
  shouldForceToolSynthesisStep,
} from "./agent-runtime-tool-synthesis"
import {
  createAiSdkFinanceDataTools,
  getAiSdkFinanceDataToolCallMetadata,
  getAiSdkFinanceDataToolResultMetadata,
  isAiSdkFinanceDataToolName,
} from "./ai-sdk-finance-data-tools"
import { createAiSdkFmpMcpToolsContext } from "./ai-sdk-fmp-mcp-tools"
import {
  createAiSdkGatewaySearchTools,
  getAiSdkGatewayProviderOptionsForMode,
  getAiSdkGatewaySearchToolCallMetadata,
  getAiSdkGatewaySearchToolResultMetadata,
  isAiSdkGatewaySearchToolName,
} from "./ai-sdk-gateway-search-tools"
import {
  createAiSdkTavilyEvidenceContext,
  createAiSdkTavilyTools,
  getAiSdkTavilyToolCallMetadata,
  getAiSdkTavilyToolResultMetadata,
  isAiSdkTavilyToolName,
} from "./ai-sdk-tavily-tools"
import {
  type CodeExecutionBackend,
  createAiSdkCodeExecutionTools,
  getAiSdkCodeExecutionToolCallMetadata,
  getAiSdkCodeExecutionToolResultMetadata,
  isAiSdkCodeExecutionToolName,
} from "./code-execution-tools"
import { createInitialReasoningChunkSanitizer } from "./initial-reasoning-chunk-sanitizer"

const logger = createLogger("agent-runtime")
const aiGatewayDispatcher = new Dispatcher1Wrapper(
  new Agent({
    bodyTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,
    headersTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,
  })
)

type UndiciRequestInit = RequestInit & {
  dispatcher: Dispatcher
}

const aiGatewayFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    dispatcher: aiGatewayDispatcher,
  } as UndiciRequestInit)

const XAI_SOURCE_PREFETCH_TIMEOUT_MS = 8_000

export type AgentRuntimeProfileId =
  | "chat_default"
  | "deep_research"
  | "finance_analysis"
  | "gdpval_workspace"

interface AgentRuntimeProfile {
  id: AgentRuntimeProfileId
  codeExecutionBackend?: CodeExecutionBackend
  codeExecutionWorkspaceMode?: "ephemeral" | "preserve"
  fmpMcpEnabled: boolean
  financeDataEnabled: boolean
  toolMaxSteps: number
}

export interface StartAgentRuntimeStreamParams {
  requestId?: string
  model: ModelType
  aiGatewayApiKey: string
  tavilyApiKey?: string
  fmpApiKey?: string
  fredApiKey?: string
  secUserAgent?: string
  userTimeZone?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  runtimeProfile?: AgentRuntimeProfileId
  temperature?: number
  signal?: AbortSignal
  codeExecutionInputFiles?: {
    sourcePath: string
    relativePath: string
  }[]
}

const AGENT_RUNTIME_PROFILES: Record<
  AgentRuntimeProfileId,
  AgentRuntimeProfile
> = {
  chat_default: {
    id: "chat_default",
    fmpMcpEnabled: true,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  deep_research: {
    id: "deep_research",
    fmpMcpEnabled: true,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_RESEARCH_TOOL_MAX_STEPS,
  },
  finance_analysis: {
    id: "finance_analysis",
    codeExecutionBackend: "finance",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  gdpval_workspace: {
    id: "gdpval_workspace",
    codeExecutionBackend: "finance",
    codeExecutionWorkspaceMode: "preserve",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
}

const FINAL_SYNTHESIS_STEP_INSTRUCTION = [
  "You are on the final synthesis step for this request.",
  "Do not call any tools on this step.",
  "Use the tool results and sources already gathered to write the final answer now.",
  "If the available evidence is incomplete, state the limitation directly and answer with the best supported facts; do not ask the user to retry.",
].join(" ")

function resolveAgentRuntimeProfile(
  id: AgentRuntimeProfileId | undefined
): AgentRuntimeProfile {
  return AGENT_RUNTIME_PROFILES[id ?? "chat_default"]
}

function shouldForceFinalSynthesisStep(
  stepNumber: number,
  toolMaxSteps: number
): boolean {
  return stepNumber >= Math.max(0, toolMaxSteps - 1)
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

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(Object.assign(new Error(message), { name: "TimeoutError" }))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeoutId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export async function* startAgentRuntimeStream(
  params: StartAgentRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const gatewayProvider = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })

  const messages = toModelMessages(params.messages)
  if (messages.length === 0) {
    return
  }

  const runtimeProfile = resolveAgentRuntimeProfile(params.runtimeProfile)
  const normalizedTavilyApiKey = params.tavilyApiKey?.trim()
  const normalizedFmpApiKey = params.fmpApiKey?.trim()
  let fmpToolsContext: Awaited<
    ReturnType<typeof createAiSdkFmpMcpToolsContext>
  > | null = null

  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()
  const sanitizeInitialReasoningChunk = createInitialReasoningChunkSanitizer()
  const toolResultStatuses = new Map<string, "success" | "error">()
  let sourceCount = 0
  let textCharCount = 0
  let toolSynthesisStepUsed = false

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
    sourceCount += 1
    return getSourceEvent(id, normalizedUrl, normalizedTitle)
  }

  try {
    const codeExecutionWorkspaceRoot =
      runtimeProfile.id === "gdpval_workspace" && AGENT_EVAL_RESULTS_DIR
        ? path.join(AGENT_EVAL_RESULTS_DIR, "workspaces", randomUUID())
        : undefined
    if (runtimeProfile.fmpMcpEnabled) {
      try {
        fmpToolsContext =
          await createAiSdkFmpMcpToolsContext(normalizedFmpApiKey)
      } catch (error) {
        logger.warn("FMP MCP tools unavailable; continuing without them.", {
          error,
          errorCode: "FMP_MCP_INIT_FAILED",
        })
      }
    }

    const tools = {
      ...createAiSdkCodeExecutionTools({
        backend: runtimeProfile.codeExecutionBackend,
        workspaceMode: runtimeProfile.codeExecutionWorkspaceMode,
        workspaceRoot:
          runtimeProfile.id === "gdpval_workspace"
            ? codeExecutionWorkspaceRoot
            : undefined,
        inputFiles:
          runtimeProfile.id === "gdpval_workspace"
            ? params.codeExecutionInputFiles
            : undefined,
      }),
      ...createAiSdkGatewaySearchTools({
        model: params.model,
        userTimeZone: params.userTimeZone,
      }),
      ...createAiSdkTavilyTools(normalizedTavilyApiKey),
      ...(runtimeProfile.financeDataEnabled
        ? createAiSdkFinanceDataTools({
            fmpApiKey: normalizedFmpApiKey,
            fredApiKey: params.fredApiKey ?? process.env.FRED_API_KEY,
            secUserAgent: params.secUserAgent ?? process.env.SEC_API_USER_AGENT,
          })
        : {}),
      ...(fmpToolsContext?.tools ?? {}),
    } as ToolSet
    const toolNames = Object.keys(tools)

    logger.info("Starting agent runtime stream.", {
      requestId: params.requestId,
      model: params.model,
      runtimeProfile: runtimeProfile.id,
      toolCount: toolNames.length,
      toolNames,
    })
    let systemInstruction = params.systemInstruction
    const prefetchQuery = getSourceBackedPromptQuery(params.model, messages)
    if (prefetchQuery && normalizedTavilyApiKey) {
      const prefetchCallId = `prefetch-tavily-${randomUUID()}`
      yield {
        type: "tool_call",
        callId: prefetchCallId,
        toolName: "tavily_search",
        label: "Searching with Tavily",
        query: prefetchQuery,
        operation: "prefetch",
        provider: "tavily",
      }

      try {
        const evidence = await withTimeout(
          createAiSdkTavilyEvidenceContext({
            apiKey: normalizedTavilyApiKey,
            query: prefetchQuery,
          }),
          XAI_SOURCE_PREFETCH_TIMEOUT_MS,
          "Tavily source prefetch timed out."
        )

        toolResultStatuses.set(prefetchCallId, "success")
        yield {
          type: "tool_result",
          callId: prefetchCallId,
          toolName: "tavily_search",
          status: "success",
          operation: "prefetch",
          provider: "tavily",
          retryable: false,
        }

        for (const source of evidence.sources) {
          const sourceEvent = createSourceEvent(
            source.id,
            source.url,
            source.title
          )
          if (sourceEvent) {
            yield sourceEvent
          }
        }

        systemInstruction = [
          systemInstruction,
          "",
          "Use the following pre-fetched web evidence for the user's current source-backed request. Include source links/citations inline when making claims from this evidence. Do not add a separate Sources, References, or Citations section.",
          evidence.context,
        ].join("\n")
      } catch (error) {
        logger.warn(
          "Tavily prefetch failed; continuing without pre-fetched evidence.",
          {
            requestId: params.requestId,
            model: params.model,
            error,
            errorCode: "TAVILY_PREFETCH_FAILED",
          }
        )
        yield {
          type: "tool_result",
          callId: prefetchCallId,
          toolName: "tavily_search",
          status: "error",
          operation: "prefetch",
          provider: "tavily",
          errorCode: "TAVILY_PREFETCH_FAILED",
          retryable: false,
        }
      }
    }

    const result = streamText({
      model: gatewayProvider(params.model),
      system: systemInstruction,
      messages,
      abortSignal: params.signal,
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      providerOptions: getAiSdkGatewayProviderOptionsForMode({
        deepResearch: runtimeProfile.id === "deep_research",
      }),
      tools,
      prepareStep: ({ messages: stepMessages, stepNumber, steps }) => {
        const compatibleMessages = getCompatibleStepMessages(
          params.model,
          stepMessages
        )
        const forceFinalSynthesis = shouldForceFinalSynthesisStep(
          stepNumber,
          runtimeProfile.toolMaxSteps
        )
        const toolSynthesisPrompt =
          !forceFinalSynthesis &&
          !toolSynthesisStepUsed &&
          shouldForceToolSynthesisStep({
            model: params.model,
            messages,
            steps,
            sourceCount,
            textCharCount,
            toolResultStatuses,
          })
            ? buildToolSynthesisPrompt(systemInstruction)
            : null

        if (toolSynthesisPrompt) {
          logger.info("Forcing xAI tool synthesis step.", {
            requestId: params.requestId,
            model: params.model,
            sourceCount,
            textCharCount,
            toolResultCount: toolResultStatuses.size,
          })
          toolSynthesisStepUsed = true
        }

        if (
          !compatibleMessages &&
          !forceFinalSynthesis &&
          !toolSynthesisPrompt
        ) {
          return undefined
        }

        return {
          ...(compatibleMessages ? { messages: compatibleMessages } : {}),
          ...(forceFinalSynthesis || toolSynthesisPrompt
            ? {
                toolChoice: "none" as const,
                system:
                  toolSynthesisPrompt ??
                  `${systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
                ...(toolSynthesisPrompt
                  ? { activeTools: [] as (keyof ToolSet)[] }
                  : {}),
              }
            : {}),
        }
      },
      stopWhen: stepCountIs(runtimeProfile.toolMaxSteps),
    })

    for await (const part of result.fullStream) {
      if (part.type === "finish-step") {
        logger.info("Agent runtime model step finished.", {
          requestId: params.requestId,
          model: params.model,
          runtimeProfile: runtimeProfile.id,
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
          runtimeProfile: runtimeProfile.id,
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
          runtimeProfile: runtimeProfile.id,
          reason: part.reason,
        })
        continue
      }

      if (part.type === "text-delta") {
        if (part.text.length > 0) {
          textCharCount += part.text.length
          yield { type: "text_delta", delta: part.text }
        }
        continue
      }

      if (part.type === "reasoning-delta") {
        const delta = sanitizeInitialReasoningChunk(part.text)
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
          getAiSdkGatewaySearchToolCallMetadata(part) ??
          getAiSdkCodeExecutionToolCallMetadata(part) ??
          getAiSdkTavilyToolCallMetadata(part) ??
          getAiSdkFinanceDataToolCallMetadata(part) ??
          fmpToolsContext?.getToolCallMetadata(part)
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
          ...("attempt" in metadata && metadata.attempt
            ? { attempt: metadata.attempt }
            : {}),
        }
        continue
      }

      if (part.type === "tool-result") {
        if (part.preliminary) {
          continue
        }

        const metadata =
          getAiSdkGatewaySearchToolResultMetadata(part) ??
          getAiSdkCodeExecutionToolResultMetadata(part) ??
          getAiSdkTavilyToolResultMetadata(part) ??
          getAiSdkFinanceDataToolResultMetadata(part) ??
          fmpToolsContext?.getToolResultMetadata(part)
        if (!metadata || finalizedToolCalls.has(metadata.callId)) {
          continue
        }

        finalizedToolCalls.add(metadata.callId)
        toolResultStatuses.set(metadata.callId, metadata.status)
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
          ...("attempt" in metadata && metadata.attempt
            ? { attempt: metadata.attempt }
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
        (isAiSdkGatewaySearchToolName(part.toolName) ||
          isAiSdkCodeExecutionToolName(part.toolName) ||
          isAiSdkTavilyToolName(part.toolName) ||
          isAiSdkFinanceDataToolName(part.toolName) ||
          fmpToolsContext?.isToolName(part.toolName)) &&
        !finalizedToolCalls.has(part.toolCallId)
      ) {
        finalizedToolCalls.add(part.toolCallId)
        toolResultStatuses.set(part.toolCallId, "error")
        const toolName =
          isAiSdkGatewaySearchToolName(part.toolName) ||
          isAiSdkCodeExecutionToolName(part.toolName) ||
          isAiSdkTavilyToolName(part.toolName) ||
          isAiSdkFinanceDataToolName(part.toolName)
            ? part.toolName
            : "fmp_mcp"
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
  } finally {
    await fmpToolsContext?.close().catch((error: unknown) => {
      logger.warn("Failed to close MCP client.", error)
    })
  }
}
