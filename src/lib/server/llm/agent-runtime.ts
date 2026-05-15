import { randomUUID } from "node:crypto"
import path from "node:path"

import { createGateway } from "@ai-sdk/gateway"
import {
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai"

import { createLogger } from "@/lib/logger"
import {
  buildAgentArtifactDownloadUrl,
  getAgentArtifactRunRoot,
} from "@/lib/server/agent-artifacts"
import { hydrateBlobBackedAttachments } from "@/lib/server/agent-attachment-blobs"
import {
  AGENT_EVAL_RESULTS_DIR,
  AGENT_FINANCE_TOOL_MAX_STEPS,
  AGENT_RESEARCH_TOOL_MAX_STEPS,
  AGENT_TOOL_MAX_STEPS,
} from "@/lib/server/agent-runtime-config"
import {
  type AgentFeatureFlags,
  getDefaultAgentFeatureFlags,
} from "@/lib/server/integration-flags"
import { hashUserId } from "@/lib/server/privacy"
import {
  type AgentStreamEvent,
  modelSupportsFileInput,
  modelSupportsImageInput,
  type ModelType,
} from "@/lib/shared"

import {
  type AgentInputMessage,
  toModelMessages,
} from "./agent-runtime-messages"
import {
  createAiSdkBrowserResearchTools,
  getAiSdkBrowserResearchToolCallMetadata,
  getAiSdkBrowserResearchToolResultMetadata,
  isAiSdkBrowserResearchToolName,
} from "./ai-sdk-browser-research-tools"
import {
  createAiSdkFinanceDataTools,
  getAiSdkFinanceDataToolCallMetadata,
  getAiSdkFinanceDataToolResultMetadata,
  isAiSdkFinanceDataToolName,
} from "./ai-sdk-finance-data-tools"
import { createAiSdkFmpMcpToolsContext } from "./ai-sdk-fmp-mcp-tools"
import { getAiSdkGatewayProviderOptionsForMode } from "./ai-sdk-gateway-provider-options"
import {
  createAiSdkKnowledgeSearchTools,
  getAiSdkKnowledgeSearchToolCallMetadata,
  getAiSdkKnowledgeSearchToolResultMetadata,
  isAiSdkKnowledgeSearchToolName,
} from "./ai-sdk-knowledge-search-tools"
import {
  createAiSdkManagedSearchTools,
  getAiSdkManagedSearchToolCallMetadata,
  getAiSdkManagedSearchToolResultMetadata,
  isAiSdkManagedSearchToolName,
} from "./ai-sdk-managed-search-tools"
import {
  createAiSdkSecFilingsTools,
  getAiSdkSecFilingsToolCallMetadata,
  getAiSdkSecFilingsToolResultMetadata,
  isAiSdkSecFilingsToolName,
} from "./ai-sdk-sec-filings-tools"
import {
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
import { aiGatewayFetch } from "./gateway-client"
import { describeImagesForTextOnlyModel } from "./image-vision-preprocessor"
import { createInitialReasoningChunkSanitizer } from "./initial-reasoning-chunk-sanitizer"
import { preparePdfAttachmentsForModel } from "./pdf-attachment-preprocessor"

const logger = createLogger("agent-runtime")

const AGENT_ARTIFACT_BASE_URL_PLACEHOLDER = "__artifact_base__"

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
  secFilingsEnabled: boolean
  toolMaxSteps: number
}

export interface StartAgentRuntimeStreamParams {
  requestId?: string
  model: ModelType
  aiGatewayApiKey: string
  tavilyApiKey?: string
  parallelApiKey?: string
  fmpApiKey?: string
  fredApiKey?: string
  secUserAgent?: string
  userTimeZone?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  runtimeProfile?: AgentRuntimeProfileId
  temperature?: number
  signal?: AbortSignal
  artifactOwnerId?: string
  userId?: string
  featureFlags?: AgentFeatureFlags
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
    secFilingsEnabled: false,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  deep_research: {
    id: "deep_research",
    fmpMcpEnabled: true,
    financeDataEnabled: true,
    secFilingsEnabled: false,
    toolMaxSteps: AGENT_RESEARCH_TOOL_MAX_STEPS,
  },
  finance_analysis: {
    id: "finance_analysis",
    codeExecutionBackend: "finance",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    secFilingsEnabled: true,
    toolMaxSteps: AGENT_FINANCE_TOOL_MAX_STEPS,
  },
  gdpval_workspace: {
    id: "gdpval_workspace",
    codeExecutionBackend: "finance",
    codeExecutionWorkspaceMode: "preserve",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    secFilingsEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
}

function buildAgentArtifactBaseUrl(artifactId: string): string | undefined {
  const placeholderUrl = buildAgentArtifactDownloadUrl(
    artifactId,
    AGENT_ARTIFACT_BASE_URL_PLACEHOLDER
  )
  if (!placeholderUrl) {
    return undefined
  }

  const placeholderSuffix = `/${AGENT_ARTIFACT_BASE_URL_PLACEHOLDER}`
  return placeholderUrl.endsWith(placeholderSuffix)
    ? placeholderUrl.slice(0, -placeholderSuffix.length)
    : undefined
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

function hasToolFailure(steps: unknown[], toolName: string): boolean {
  return steps.some((step) => {
    const content = (step as { content?: unknown[] }).content
    if (!Array.isArray(content)) {
      return false
    }

    return content.some((part) => {
      const record = part as {
        type?: string
        toolName?: string
        output?: unknown
      }
      if (record.toolName !== toolName) {
        return false
      }

      if (record.type === "tool-error") {
        return true
      }

      if (record.type !== "tool-result") {
        return false
      }

      const output = record.output as { error?: unknown } | undefined
      return Boolean(output && typeof output === "object" && output.error)
    })
  })
}

function getActiveToolsForSearchFallback(params: {
  toolNames: string[]
  steps: unknown[]
  parallelEnabled: boolean
}): string[] | undefined {
  if (
    !params.parallelEnabled ||
    !params.toolNames.includes("parallel_search") ||
    !params.toolNames.includes("gateway_web_search")
  ) {
    return undefined
  }

  if (hasToolFailure(params.steps, "parallel_search")) {
    return undefined
  }

  return params.toolNames.filter((toolName) => toolName !== "gateway_web_search")
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
  const userId = params.userId ?? params.artifactOwnerId
  const featureFlags = params.featureFlags ?? getDefaultAgentFeatureFlags()
  const gatewayProvider = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })

  const blobHydratedMessages = await hydrateBlobBackedAttachments({
    messages: params.messages,
    userId,
    signal: params.signal,
  })

  const pdfPreparedMessages = await preparePdfAttachmentsForModel({
    messages: blobHydratedMessages,
    aiGatewayApiKey: params.aiGatewayApiKey,
    signal: params.signal,
    preservePdfAttachments: modelSupportsFileInput(params.model),
  })
  const inputMessages = modelSupportsImageInput(params.model)
    ? pdfPreparedMessages
    : await describeImagesForTextOnlyModel({
        messages: pdfPreparedMessages,
        aiGatewayApiKey: params.aiGatewayApiKey,
        signal: params.signal,
      })

  const messages = toModelMessages(inputMessages)
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
    const artifactRunId =
      runtimeProfile.id === "finance_analysis" && params.artifactOwnerId
        ? randomUUID()
        : undefined
    const codeExecutionWorkspaceRoot =
      runtimeProfile.id === "gdpval_workspace" && AGENT_EVAL_RESULTS_DIR
        ? path.join(AGENT_EVAL_RESULTS_DIR, "workspaces", randomUUID())
        : artifactRunId && params.artifactOwnerId
          ? getAgentArtifactRunRoot({
              artifactId: artifactRunId,
              userId: params.artifactOwnerId,
            })
          : undefined
    const codeExecutionWorkspaceMode =
      runtimeProfile.codeExecutionWorkspaceMode ??
      (artifactRunId ? "preserve" : undefined)
    const artifactBaseUrl = artifactRunId
      ? buildAgentArtifactBaseUrl(artifactRunId)
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
        workspaceMode: codeExecutionWorkspaceMode,
        workspaceRoot:
          runtimeProfile.id === "gdpval_workspace" || artifactRunId
            ? codeExecutionWorkspaceRoot
            : undefined,
        artifactBaseUrl,
        artifactUpload:
          artifactRunId && userId
            ? {
                artifactId: artifactRunId,
                userId,
              }
            : undefined,
        exposeArtifactDirectory: runtimeProfile.id === "gdpval_workspace",
        inputFiles:
          runtimeProfile.id === "gdpval_workspace"
            ? params.codeExecutionInputFiles
            : undefined,
      }),
      ...createAiSdkTavilyTools(normalizedTavilyApiKey),
      ...createAiSdkManagedSearchTools({
        parallelApiKey: params.parallelApiKey,
      }),
      ...createAiSdkKnowledgeSearchTools({
        enabled: featureFlags.knowledgeSearchEnabled,
        userId,
      }),
      ...createAiSdkBrowserResearchTools({
        enabled: featureFlags.browserbaseEnabled,
        userId,
        requestId: params.requestId,
      }),
      ...(runtimeProfile.financeDataEnabled
        ? createAiSdkFinanceDataTools({
            fmpApiKey: normalizedFmpApiKey,
            fredApiKey: params.fredApiKey ?? process.env.FRED_API_KEY,
            secUserAgent: params.secUserAgent ?? process.env.SEC_API_USER_AGENT,
          })
        : {}),
      ...(runtimeProfile.secFilingsEnabled
        ? createAiSdkSecFilingsTools({
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
    const systemInstruction = params.systemInstruction

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
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: featureFlags.telemetryRecordIo,
        recordOutputs: featureFlags.telemetryRecordIo,
        functionId: "chloei.agent.stream",
        metadata: {
          requestId: params.requestId ?? "",
          modelId: params.model,
          runtimeProfile: runtimeProfile.id,
          toolNames: toolNames.join(","),
          userHash: userId ? hashUserId(userId) : "",
        },
      },
      tools,
      prepareStep: ({ stepNumber, steps }) => {
        const forceFinalSynthesis = shouldForceFinalSynthesisStep(
          stepNumber,
          runtimeProfile.toolMaxSteps
        )
        const activeTools = getActiveToolsForSearchFallback({
          toolNames,
          steps,
          parallelEnabled: Boolean(params.parallelApiKey?.trim()),
        })
        if (!forceFinalSynthesis) {
          return activeTools ? { activeTools } : undefined
        }

        return {
          toolChoice: "none" as const,
          system: `${systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
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
          getAiSdkCodeExecutionToolCallMetadata(part) ??
          getAiSdkTavilyToolCallMetadata(part) ??
          getAiSdkManagedSearchToolCallMetadata(part) ??
          getAiSdkKnowledgeSearchToolCallMetadata(part) ??
          getAiSdkBrowserResearchToolCallMetadata(part) ??
          getAiSdkFinanceDataToolCallMetadata(part) ??
          getAiSdkSecFilingsToolCallMetadata(part) ??
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
          getAiSdkCodeExecutionToolResultMetadata(part) ??
          getAiSdkTavilyToolResultMetadata(part) ??
          getAiSdkManagedSearchToolResultMetadata(part) ??
          getAiSdkKnowledgeSearchToolResultMetadata(part) ??
          getAiSdkBrowserResearchToolResultMetadata(part) ??
          getAiSdkFinanceDataToolResultMetadata(part) ??
          getAiSdkSecFilingsToolResultMetadata(part) ??
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
          ...("artifactManifest" in metadata &&
          metadata.artifactManifest?.length
            ? { artifactManifest: metadata.artifactManifest }
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
          isAiSdkTavilyToolName(part.toolName) ||
          isAiSdkManagedSearchToolName(part.toolName) ||
          isAiSdkKnowledgeSearchToolName(part.toolName) ||
          isAiSdkBrowserResearchToolName(part.toolName) ||
          isAiSdkFinanceDataToolName(part.toolName) ||
          isAiSdkSecFilingsToolName(part.toolName) ||
          fmpToolsContext?.isToolName(part.toolName)) &&
        !finalizedToolCalls.has(part.toolCallId)
      ) {
        finalizedToolCalls.add(part.toolCallId)
        const toolName =
          isAiSdkCodeExecutionToolName(part.toolName) ||
          isAiSdkTavilyToolName(part.toolName) ||
          isAiSdkManagedSearchToolName(part.toolName) ||
          isAiSdkKnowledgeSearchToolName(part.toolName) ||
          isAiSdkBrowserResearchToolName(part.toolName) ||
          isAiSdkFinanceDataToolName(part.toolName) ||
          isAiSdkSecFilingsToolName(part.toolName)
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
