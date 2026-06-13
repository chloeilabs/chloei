import { gateway, type ToolSet } from "ai"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ToolName } from "@/lib/shared"

const GATEWAY_WEB_SEARCH_TOOL_NAME = "gateway_web_search" as const
const MANAGED_SEARCH_MAX_RESULTS = 8

type ManagedSearchToolName = Extract<
  ToolName,
  typeof GATEWAY_WEB_SEARCH_TOOL_NAME
>

interface ManagedSearchToolCallMetadata {
  callId: string
  toolName: ManagedSearchToolName
  label: string
  query?: string
  operation: "search"
  provider: "vercel_ai_gateway"
}

interface ManagedSearchToolResultMetadata {
  callId: string
  toolName: ManagedSearchToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation: "search"
  provider: "vercel_ai_gateway"
  errorCode?: string
  retryable: boolean
}

function getToolName(value: string | undefined): ManagedSearchToolName | null {
  return value === GATEWAY_WEB_SEARCH_TOOL_NAME ? value : null
}

export function isAiSdkManagedSearchToolName(
  value: unknown
): value is ManagedSearchToolName {
  return getToolName(typeof value === "string" ? value : undefined) !== null
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function getResultUrl(result: Record<string, unknown>): string | undefined {
  return toOptionalString(result.url)
}

function getResultTitle(result: Record<string, unknown>): string | undefined {
  return toOptionalString(result.title)
}

function getRequestId(
  toolName: ManagedSearchToolName,
  output: Record<string, unknown>
): string {
  return (
    toOptionalString(output.search_id) ??
    toOptionalString(output.searchId) ??
    `${toolName}-${crypto.randomUUID()}`
  )
}

function getErrorCode(output: Record<string, unknown>): string | undefined {
  const nestedError = asRecord(output.error)
  return (
    toOptionalString(output.error) ??
    toOptionalString(nestedError?.code) ??
    toOptionalString(nestedError?.error) ??
    toOptionalString(output.code) ??
    toOptionalString(output.errorCode)
  )
}

function isErrorOutput(output: Record<string, unknown>): boolean {
  return Boolean(getErrorCode(output))
}

function toSourcesFromOutput(
  toolName: ManagedSearchToolName,
  output: Record<string, unknown>
): MessageSource[] {
  const results = Array.isArray(output.results) ? output.results : []
  const requestId = getRequestId(toolName, output)

  return results
    .map((result, index) => {
      const record = asRecord(result)
      if (!record) {
        return null
      }

      const url = getResultUrl(record)
      if (!url) {
        return null
      }

      return {
        id: `${toolName}-${requestId}-${String(index)}`,
        url,
        title: getResultTitle(record) ?? url,
      }
    })
    .filter((source): source is MessageSource => source !== null)
}

export function createAiSdkManagedSearchTools(): ToolSet {
  return {
    gateway_web_search: gateway.tools.parallelSearch({
      mode: "one-shot",
      maxResults: MANAGED_SEARCH_MAX_RESULTS,
      excerpts: {
        maxCharsPerResult: 4000,
      },
    }),
  }
}

export function getAiSdkManagedSearchToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): ManagedSearchToolCallMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const inputRecord = asRecord(part.input)
  const query =
    toOptionalString(inputRecord?.objective) ??
    (Array.isArray(inputRecord?.search_queries)
      ? inputRecord.search_queries
          .map((value) => toOptionalString(value))
          .filter((value): value is string => Boolean(value))
          .join("; ")
      : undefined)

  return {
    callId: part.toolCallId,
    toolName,
    label: "Searching with AI Gateway",
    ...(query ? { query } : {}),
    operation: "search",
    provider: "vercel_ai_gateway",
  }
}

export function getAiSdkManagedSearchToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): ManagedSearchToolResultMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const output = asRecord(part.output)
  if (!output) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
      operation: "search",
      provider: "vercel_ai_gateway",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  const errorCode = getErrorCode(output)
  if (isErrorOutput(output)) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
      operation: "search",
      provider: "vercel_ai_gateway",
      ...(errorCode ? { errorCode } : {}),
      retryable: true,
    }
  }

  return {
    callId: part.toolCallId,
    toolName,
    status: "success",
    sources: toSourcesFromOutput(toolName, output),
    operation: "search",
    provider: "vercel_ai_gateway",
    retryable: false,
  }
}
