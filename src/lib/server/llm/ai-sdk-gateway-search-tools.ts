import {
  anthropic,
  type AnthropicLanguageModelOptions,
} from "@ai-sdk/anthropic"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ModelType, ToolName } from "@/lib/shared"

const WEB_SEARCH_TOOL_NAME = "web_search" as const
const ANTHROPIC_WEB_SEARCH_MAX_USES = 5

type AiSdkGatewaySearchToolName = Extract<ToolName, typeof WEB_SEARCH_TOOL_NAME>

interface AiSdkGatewaySearchToolCallMetadata {
  callId: string
  toolName: AiSdkGatewaySearchToolName
  label: string
  query?: string
  operation?: string
  provider?: string
}

interface AiSdkGatewaySearchToolResultMetadata {
  callId: string
  toolName: AiSdkGatewaySearchToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  errorCode?: string
  retryable?: boolean
}

function getToolName(
  value: string | undefined
): AiSdkGatewaySearchToolName | null {
  return value === WEB_SEARCH_TOOL_NAME ? value : null
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function getToolLabel(): string {
  return "Searching Web"
}

function getToolQuery(input: unknown): string | undefined {
  const inputRecord = asRecord(input)
  return toOptionalString(inputRecord?.query)
}

function createSource(
  callId: string,
  index: number,
  url: string,
  title: string | null | undefined
): MessageSource | null {
  const normalizedUrl = url.trim()
  if (!normalizedUrl) {
    return null
  }

  const normalizedTitle = title?.trim() ?? normalizedUrl
  return {
    id: `${WEB_SEARCH_TOOL_NAME}-${callId}-${String(index)}`,
    url: normalizedUrl,
    title: normalizedTitle,
  }
}

function toWebSearchSources(
  output: unknown,
  callId: string
): MessageSource[] | null {
  if (!Array.isArray(output)) {
    return null
  }

  return output.flatMap((entry, index) => {
    const record = asRecord(entry)
    const url = toOptionalString(record?.url)
    if (!url) {
      return []
    }

    const source = createSource(callId, index, url, asString(record?.title))

    return source ? [source] : []
  })
}

function isToolErrorOutput(output: unknown): boolean {
  const outputRecord = asRecord(output)
  return typeof outputRecord?.error === "string"
}

function getAnthropicWebSearchOptions(userTimeZone?: string) {
  const normalizedTimeZone = toOptionalString(userTimeZone)

  return {
    maxUses: ANTHROPIC_WEB_SEARCH_MAX_USES,
    ...(normalizedTimeZone
      ? {
          userLocation: {
            type: "approximate" as const,
            timezone: normalizedTimeZone,
          },
        }
      : {}),
  } satisfies Parameters<typeof anthropic.tools.webSearch_20250305>[0]
}

interface CreateAiSdkGatewaySearchToolsParams {
  model: ModelType
  userTimeZone?: string
}

export function createAiSdkGatewaySearchTools(
  params: CreateAiSdkGatewaySearchToolsParams
) {
  if (!params.model.startsWith("anthropic/")) {
    return {}
  }

  return {
    web_search: anthropic.tools.webSearch_20250305(
      getAnthropicWebSearchOptions(params.userTimeZone)
    ),
  }
}

export function getAiSdkGatewayProviderOptions() {
  return {
    anthropic: {
      sendReasoning: true,
      thinking: {
        type: "adaptive",
        display: "summarized",
      },
      effort: "high",
    } satisfies AnthropicLanguageModelOptions,
    openai: {
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    },
  }
}

export function isAiSdkGatewaySearchToolName(
  value: unknown
): value is AiSdkGatewaySearchToolName {
  return getToolName(typeof value === "string" ? value : undefined) !== null
}

export function getAiSdkGatewaySearchToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkGatewaySearchToolCallMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const query = getToolQuery(part.input)

  return {
    callId: part.toolCallId,
    toolName,
    label: getToolLabel(),
    ...(query ? { query } : {}),
    operation: "web_search",
    provider: "ai_gateway",
  }
}

export function getAiSdkGatewaySearchToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkGatewaySearchToolResultMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  if (isToolErrorOutput(part.output)) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
      operation: "web_search",
      provider: "ai_gateway",
      errorCode: "WEB_SEARCH_ERROR",
      retryable: true,
    }
  }

  const sources = toWebSearchSources(part.output, part.toolCallId)

  return {
    callId: part.toolCallId,
    toolName,
    status: sources ? "success" : "error",
    sources: sources ?? [],
    operation: "web_search",
    provider: "ai_gateway",
    ...(sources ? {} : { errorCode: "WEB_SEARCH_RESULT_UNAVAILABLE" }),
    retryable: !sources,
  }
}
