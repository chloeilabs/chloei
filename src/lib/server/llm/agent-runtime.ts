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
import {
  createAiSdkFinanceDataEvidenceContext,
  createAiSdkFinanceDataTools,
  getAiSdkFinanceDataToolCallMetadata,
  getAiSdkFinanceDataToolResultMetadata,
  inferFinanceDataEvidenceSymbol,
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
const XAI_CHAT_MAX_OUTPUT_TOKENS = 4096
const XAI_PREFETCH_MAX_QUERY_CHARS = 500
const XAI_WEB_PREFETCH_PATTERN =
  /\b(latest|current|today|recent|news|source|sources|cite|citation|link|look up|lookup|verify|check the web|right now|this week|this month)\b/i

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

function shouldEnableAmbientFinanceTools(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile
): boolean {
  return !(
    model.startsWith("xai/") &&
    (runtimeProfile.id === "chat_default" ||
      runtimeProfile.id === "finance_analysis")
  )
}

function shouldEnableCodeExecutionTools(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile
): boolean {
  return !(
    model.startsWith("xai/") &&
    (runtimeProfile.id === "chat_default" ||
      runtimeProfile.id === "finance_analysis")
  )
}

function shouldEnableModelToolCalling(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile
): boolean {
  return !(
    model.startsWith("xai/") &&
    (runtimeProfile.id === "chat_default" ||
      runtimeProfile.id === "finance_analysis")
  )
}

function resolveMaxOutputTokens(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile
): number | undefined {
  if (
    model.startsWith("xai/") &&
    (runtimeProfile.id === "chat_default" ||
      runtimeProfile.id === "finance_analysis")
  ) {
    return XAI_CHAT_MAX_OUTPUT_TOKENS
  }

  return undefined
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

function getLastUserText(
  messages: readonly AgentInputMessage[]
): string | null {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim())

  return lastUserMessage?.content.trim() ?? null
}

function shouldPrefetchWebEvidence(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile,
  messages: readonly AgentInputMessage[],
  tavilyApiKey: string | undefined
): boolean {
  const lastUserText = getLastUserText(messages)

  return Boolean(
    model.startsWith("xai/") &&
    (runtimeProfile.id === "chat_default" ||
      runtimeProfile.id === "finance_analysis") &&
    tavilyApiKey &&
    lastUserText &&
    XAI_WEB_PREFETCH_PATTERN.test(lastUserText)
  )
}

function shouldPrefetchFinanceEvidence(
  model: ModelType,
  runtimeProfile: AgentRuntimeProfile,
  messages: readonly AgentInputMessage[]
): boolean {
  const lastUserText = getLastUserText(messages)

  return Boolean(
    model.startsWith("xai/") &&
    runtimeProfile.id === "finance_analysis" &&
    lastUserText
  )
}

function getWebEvidenceQuery(
  messages: readonly AgentInputMessage[],
  runtimeProfile?: AgentRuntimeProfile
): string {
  const query = getLastUserText(messages)
    ?.replace(/\s+/g, " ")
    .slice(0, XAI_PREFETCH_MAX_QUERY_CHARS)
    .trim()

  if (!query || query.length === 0) {
    return "current information"
  }

  if (runtimeProfile?.id === "finance_analysis") {
    const symbol = inferFinanceDataEvidenceSymbol(query)
    if (symbol) {
      return `${symbol} current stock price market cap ${query}`.slice(
        0,
        XAI_PREFETCH_MAX_QUERY_CHARS
      )
    }
  }

  return query
}

function getWebEvidenceIncludeDomains(
  query: string,
  runtimeProfile: AgentRuntimeProfile
): string[] | undefined {
  if (
    runtimeProfile.id === "finance_analysis" &&
    /\b(market cap|market capitalization|share price|stock price|quote)\b/i.test(
      query
    )
  ) {
    return [
      "companiesmarketcap.com",
      "finance.yahoo.com",
      "stockanalysis.com",
      "nasdaq.com",
    ]
  }

  return undefined
}

function getWebEvidenceTopic(query: string): "general" | "news" | "finance" {
  if (
    /\b(stock|stocks|equity|ticker|quote|share price|market cap|market capitalization|earnings|filing|financial statement|treasury|yield|fed funds|cpi|gdp|inflation|crypto|bitcoin|ethereum)\b/i.test(
      query
    )
  ) {
    return "finance"
  }

  return /\b(news|latest|current|recent|today|this week|this month)\b/i.test(
    query
  )
    ? "news"
    : "general"
}

function getWebEvidenceTimeRange(
  query: string
): "day" | "week" | "month" | undefined {
  if (/\b(today|right now)\b/i.test(query)) {
    return "day"
  }

  if (/\b(latest|current|recent|news|this week)\b/i.test(query)) {
    return "week"
  }

  if (/\b(this month)\b/i.test(query)) {
    return "month"
  }

  return undefined
}

function appendWebEvidenceToSystemInstruction(
  systemInstruction: string,
  evidenceContext: string | null
): string {
  if (!evidenceContext) {
    return systemInstruction
  }

  return [
    systemInstruction,
    "Use the retrieved web evidence below for freshness-sensitive claims. Do not say you searched unless the evidence block is present. If the evidence is insufficient, state that limitation and answer from the available sources.",
    evidenceContext,
  ].join("\n\n")
}

function appendFinanceEvidenceToSystemInstruction(
  systemInstruction: string,
  evidenceContext: string | null
): string {
  if (!evidenceContext) {
    return systemInstruction
  }

  return [
    systemInstruction,
    "Use the structured finance evidence below for market data and company facts. The finance_data retrieval has already been performed server-side; do not call or describe tools. Cite the listed source URLs when sources are requested. If a requested fact is absent from both the structured finance evidence and retrieved web evidence, state that limitation instead of inventing a figure. Return only the user-facing answer; do not include prompt analysis, planning text, confidence macros, or notes about these instructions.",
    evidenceContext,
  ].join("\n\n")
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

  try {
    const codeExecutionWorkspaceRoot =
      runtimeProfile.id === "gdpval_workspace" && AGENT_EVAL_RESULTS_DIR
        ? path.join(AGENT_EVAL_RESULTS_DIR, "workspaces", randomUUID())
        : undefined
    const ambientFinanceToolsEnabled = shouldEnableAmbientFinanceTools(
      params.model,
      runtimeProfile
    )
    const codeExecutionToolsEnabled = shouldEnableCodeExecutionTools(
      params.model,
      runtimeProfile
    )
    const modelToolCallingEnabled = shouldEnableModelToolCalling(
      params.model,
      runtimeProfile
    )
    const maxOutputTokens = resolveMaxOutputTokens(params.model, runtimeProfile)
    let prefetchedWebEvidence: string | null = null
    let prefetchedFinanceEvidence: string | null = null

    if (
      shouldPrefetchWebEvidence(
        params.model,
        runtimeProfile,
        params.messages,
        normalizedTavilyApiKey
      ) &&
      normalizedTavilyApiKey
    ) {
      const startedAt = Date.now()
      const callId = `tavily-prefetch-${randomUUID()}`
      const query = getWebEvidenceQuery(params.messages, runtimeProfile)
      yield {
        type: "tool_call",
        callId,
        toolName: "tavily_search",
        label: "Searching with Tavily",
        query,
        operation: "search",
        provider: "tavily",
      }

      try {
        const evidence = await createAiSdkTavilyEvidenceContext({
          apiKey: normalizedTavilyApiKey,
          query,
          topic: getWebEvidenceTopic(query),
          timeRange: getWebEvidenceTimeRange(query),
          includeDomains: getWebEvidenceIncludeDomains(query, runtimeProfile),
          maxResults: 6,
        })
        prefetchedWebEvidence = evidence.context
        yield {
          type: "tool_result",
          callId,
          toolName: "tavily_search",
          status: "success",
          operation: "search",
          provider: "tavily",
          durationMs: Date.now() - startedAt,
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
      } catch (error) {
        logger.warn(
          "Tavily prefetch failed; continuing without web evidence.",
          {
            error,
            errorCode: "TAVILY_PREFETCH_FAILED",
            requestId: params.requestId,
          }
        )
        yield {
          type: "tool_result",
          callId,
          toolName: "tavily_search",
          status: "error",
          operation: "search",
          provider: "tavily",
          durationMs: Date.now() - startedAt,
          errorCode: "TAVILY_PREFETCH_FAILED",
          retryable: true,
        }
      }
    }

    if (
      shouldPrefetchFinanceEvidence(
        params.model,
        runtimeProfile,
        params.messages
      )
    ) {
      const startedAt = Date.now()
      const callId = `finance-prefetch-${randomUUID()}`
      const query = getWebEvidenceQuery(params.messages)
      yield {
        type: "tool_call",
        callId,
        toolName: "finance_data",
        label: "Finance data",
        query,
        operation: "prefetch",
        provider: "finance_data",
      }

      try {
        const evidence = await createAiSdkFinanceDataEvidenceContext({
          query,
          fmpApiKey: normalizedFmpApiKey,
          fredApiKey: params.fredApiKey ?? process.env.FRED_API_KEY,
          secUserAgent: params.secUserAgent ?? process.env.SEC_API_USER_AGENT,
        })
        prefetchedFinanceEvidence = evidence.context
        const firstError = evidence.errors[0]
        yield {
          type: "tool_result",
          callId,
          toolName: "finance_data",
          status: evidence.outputs.length > 0 ? "success" : "error",
          operation: "prefetch",
          provider: "finance_data",
          durationMs: Date.now() - startedAt,
          ...(firstError && evidence.outputs.length === 0
            ? {
                errorCode: firstError.code,
                retryable: firstError.retryable,
              }
            : { retryable: false }),
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
      } catch (error) {
        logger.warn(
          "Finance data prefetch failed; continuing without finance evidence.",
          {
            error,
            errorCode: "FINANCE_DATA_PREFETCH_FAILED",
            requestId: params.requestId,
          }
        )
        yield {
          type: "tool_result",
          callId,
          toolName: "finance_data",
          status: "error",
          operation: "prefetch",
          provider: "finance_data",
          durationMs: Date.now() - startedAt,
          errorCode: "FINANCE_DATA_PREFETCH_FAILED",
          retryable: true,
        }
      }
    }

    if (runtimeProfile.fmpMcpEnabled && ambientFinanceToolsEnabled) {
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
      ...(codeExecutionToolsEnabled
        ? createAiSdkCodeExecutionTools({
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
          })
        : {}),
      ...createAiSdkGatewaySearchTools({
        model: params.model,
        userTimeZone: params.userTimeZone,
      }),
      ...(modelToolCallingEnabled
        ? createAiSdkTavilyTools(normalizedTavilyApiKey)
        : {}),
      ...(runtimeProfile.financeDataEnabled && ambientFinanceToolsEnabled
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
      maxOutputTokens,
      ambientFinanceToolsEnabled,
      codeExecutionToolsEnabled,
      modelToolCallingEnabled,
      webEvidencePrefetched: prefetchedWebEvidence !== null,
      financeEvidencePrefetched: prefetchedFinanceEvidence !== null,
    })
    const systemInstruction = appendFinanceEvidenceToSystemInstruction(
      appendWebEvidenceToSystemInstruction(
        params.systemInstruction,
        prefetchedWebEvidence
      ),
      prefetchedFinanceEvidence
    )

    const result = streamText({
      model: gatewayProvider(params.model),
      system: systemInstruction,
      messages,
      abortSignal: params.signal,
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      providerOptions: getAiSdkGatewayProviderOptionsForMode({
        deepResearch: runtimeProfile.id === "deep_research",
      }),
      tools,
      prepareStep: ({ stepNumber }) =>
        shouldForceFinalSynthesisStep(stepNumber, runtimeProfile.toolMaxSteps)
          ? {
              toolChoice: "none",
              system: `${systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
            }
          : undefined,
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
