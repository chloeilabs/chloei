import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai"

import { asRecord, asString } from "@/lib/cast"
import { AGENT_TOOL_MAX_STEPS } from "@/lib/server/agent-runtime-config"
import { type AgentStreamEvent, type ModelType } from "@/lib/shared"

import { createAiSdkFmpMcpToolsContext } from "./ai-sdk-fmp-mcp-tools"
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

interface AgentInputMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface StartOpenRouterResponseStreamParams {
  model: ModelType
  openRouterApiKey: string
  tavilyApiKey?: string
  fmpApiKey?: string
  messages: AgentInputMessage[]
  systemInstruction: string
  temperature?: number
  signal?: AbortSignal
}

const OPENROUTER_REASONING_EFFORT = "high" as const

function toModelMessages(messages: AgentInputMessage[]): ModelMessage[] {
  const inputMessages: ModelMessage[] = []

  for (const message of messages) {
    const content = message.content.trim()
    if (!content) {
      continue
    }

    if (message.role === "system") {
      inputMessages.push({ role: "system", content })
      continue
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

function shouldSkipOpenRouterReasoningChunk(
  text: string,
  providerMetadata: unknown
): boolean {
  if (text.trim() !== "[REDACTED]") {
    return false
  }

  const metadataRecord = asRecord(providerMetadata)
  const openRouterRecord = asRecord(metadataRecord?.openrouter)
  const reasoningDetails = openRouterRecord?.reasoning_details
  if (!Array.isArray(reasoningDetails) || reasoningDetails.length === 0) {
    return false
  }

  return reasoningDetails.some((detail) => {
    const detailRecord = asRecord(detail)
    return asString(detailRecord?.type) === "reasoning.encrypted"
  })
}

export async function* startOpenRouterResponseStream(
  params: StartOpenRouterResponseStreamParams
): AsyncGenerator<AgentStreamEvent> {
  const provider = createOpenRouter({
    apiKey: params.openRouterApiKey,
  })

  const messages = toModelMessages(params.messages)
  if (messages.length === 0) {
    return
  }

  const normalizedTavilyApiKey = params.tavilyApiKey?.trim()
  const normalizedFmpApiKey = params.fmpApiKey?.trim()
  const fmpToolsContext =
    await createAiSdkFmpMcpToolsContext(normalizedFmpApiKey)

  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()

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
    const tools = {
      ...createAiSdkCodeExecutionTools(),
      ...createAiSdkTavilyTools(normalizedTavilyApiKey),
      ...(fmpToolsContext?.tools ?? {}),
    } as ToolSet

    const result = streamText({
      model: provider.chat(params.model),
      system: params.systemInstruction,
      messages,
      abortSignal: params.signal,
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      providerOptions: {
        openrouter: {
          reasoning: {
            effort: OPENROUTER_REASONING_EFFORT,
          },
        },
      },
      tools,
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
        if (
          part.text.length > 0 &&
          !shouldSkipOpenRouterReasoningChunk(part.text, part.providerMetadata)
        ) {
          yield { type: "reasoning_delta", delta: part.text }
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
          fmpToolsContext?.getToolResultMetadata(part)
        if (!metadata || finalizedToolCalls.has(metadata.callId)) {
          continue
        }

        finalizedToolCalls.add(metadata.callId)
        yield {
          type: "tool_result",
          callId: metadata.callId,
          status: metadata.status,
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
          fmpToolsContext?.isToolName(part.toolName)) &&
        !finalizedToolCalls.has(part.toolCallId)
      ) {
        finalizedToolCalls.add(part.toolCallId)
        yield {
          type: "tool_result",
          callId: part.toolCallId,
          status: "error",
        }
      }
    }
  } finally {
    await fmpToolsContext?.close().catch((error: unknown) => {
      console.warn("[fmp-mcp] Failed to close MCP client:", error)
    })
  }
}
