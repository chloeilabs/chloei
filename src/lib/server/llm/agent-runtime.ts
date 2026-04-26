import { createGateway } from "@ai-sdk/gateway"
import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai"

import { createLogger } from "@/lib/logger"
import {
  AGENT_EVAL_RESULTS_DIR,
  AGENT_TOOL_MAX_STEPS,
} from "@/lib/server/agent-runtime-config"
import { type AgentStreamEvent, type ModelType } from "@/lib/shared"

import {
  createAiSdkFinanceDataTools,
  getAiSdkFinanceDataToolCallMetadata,
  getAiSdkFinanceDataToolResultMetadata,
  isAiSdkFinanceDataToolName,
} from "./ai-sdk-finance-data-tools"
import { createAiSdkFmpMcpToolsContext } from "./ai-sdk-fmp-mcp-tools"
import {
  createAiSdkGatewaySearchTools,
  getAiSdkGatewayProviderOptions,
  getAiSdkGatewaySearchToolCallMetadata,
  getAiSdkGatewaySearchToolResultMetadata,
  isAiSdkGatewaySearchToolName,
} from "./ai-sdk-gateway-search-tools"
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
import { createInitialReasoningChunkSanitizer } from "./initial-reasoning-chunk-sanitizer"

const logger = createLogger("agent-runtime")

export type AgentRuntimeProfileId =
  | "chat_default"
  | "finance_analysis"
  | "gdpval_workspace"

interface AgentRuntimeProfile {
  id: AgentRuntimeProfileId
  codeExecutionBackend?: CodeExecutionBackend
  codeExecutionWorkspaceMode?: "ephemeral" | "preserve"
  fmpMcpEnabled: boolean
  financeDataEnabled: boolean
}

interface AgentInputMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface StartAgentRuntimeStreamParams {
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
  },
  finance_analysis: {
    id: "finance_analysis",
    codeExecutionBackend: "finance",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
  },
  gdpval_workspace: {
    id: "gdpval_workspace",
    codeExecutionBackend: "finance",
    codeExecutionWorkspaceMode: "preserve",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
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

function shouldForceFinalSynthesisStep(stepNumber: number): boolean {
  return stepNumber >= Math.max(0, AGENT_TOOL_MAX_STEPS - 1)
}

function toModelMessages(messages: AgentInputMessage[]): ModelMessage[] {
  const inputMessages: ModelMessage[] = []

  for (const message of messages) {
    const content = message.content.trim()
    if (!content) {
      continue
    }

    if (message.role === "system") {
      throw new Error(
        "System messages must be provided via systemInstruction, not messages."
      )
    }

    inputMessages.push({
      role: message.role,
      content,
    })
  }

  return inputMessages
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

export async function* startAgentRuntimeStream(
  params: StartAgentRuntimeStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const gatewayProvider = createGateway({
    apiKey: params.aiGatewayApiKey,
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
    const key = `${normalizedUrl}::${normalizedTitle}`
    if (!normalizedUrl || seenSourceKeys.has(key)) {
      return null
    }

    seenSourceKeys.add(key)
    return getSourceEvent(id, normalizedUrl, normalizedTitle)
  }

  try {
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
            ? AGENT_EVAL_RESULTS_DIR
            : undefined,
        inputFiles:
          runtimeProfile.id === "gdpval_workspace"
            ? params.codeExecutionInputFiles
            : undefined,
      }),
      ...createAiSdkGatewaySearchTools(params.userTimeZone),
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

    const result = streamText({
      model: gatewayProvider(params.model),
      system: params.systemInstruction,
      messages,
      abortSignal: params.signal,
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      providerOptions: getAiSdkGatewayProviderOptions(),
      tools,
      prepareStep: ({ stepNumber }) =>
        shouldForceFinalSynthesisStep(stepNumber)
          ? {
              toolChoice: "none",
              system: `${params.systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`,
            }
          : undefined,
      stopWhen: stepCountIs(AGENT_TOOL_MAX_STEPS),
    })

    for await (const part of result.fullStream) {
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
