import { createSearchTool } from "@parallel-web/ai-sdk-tools"
import { gateway, type ToolSet } from "ai"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ToolName } from "@/lib/shared"

const PARALLEL_SEARCH_TOOL_NAME = "parallel_search" as const
const GATEWAY_WEB_SEARCH_TOOL_NAME = "gateway_web_search" as const
const MANAGED_SEARCH_MAX_RESULTS = 8

type ManagedSearchToolName = Extract<
  ToolName,
  typeof PARALLEL_SEARCH_TOOL_NAME | typeof GATEWAY_WEB_SEARCH_TOOL_NAME
>

interface ManagedSearchToolCallMetadata {
  callId: string
  toolName: ManagedSearchToolName
  label: string
  query?: string
  operation: "search"
  provider: "parallel" | "vercel_ai_gateway"
}

interface ManagedSearchToolResultMetadata {
  callId: string
  toolName: ManagedSearchToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation: "search"
  provider: "parallel" | "vercel_ai_gateway"
  errorCode?: string
  retryable: boolean
}

function getToolName(value: string | undefined): ManagedSearchToolName | null {
  if (
    value === PARALLEL_SEARCH_TOOL_NAME ||
    value === GATEWAY_WEB_SEARCH_TOOL_NAME
  ) {
    return value
  }

  return null
}

export function isAiSdkManagedSearchToolName(
  value: unknown
): value is ManagedSearchToolName {
  return getToolName(typeof value === "string" ? value : undefined) !== null
}

function getProvider(
  toolName: ManagedSearchToolName
): ManagedSearchToolCallMetadata["provider"] {
  return toolName === PARALLEL_SEARCH_TOOL_NAME
    ? "parallel"
    : "vercel_ai_gateway"
}

function getToolLabel(toolName: ManagedSearchToolName): string {
  return toolName === PARALLEL_SEARCH_TOOL_NAME
    ? "Searching with Parallel"
    : "Searching with AI Gateway"
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
  return Boolean(getErrorCode(output) ?? toOptionalString(output.message))
}

function getErrorMessage(error: unknown): string {
  const record = asRecord(error)
  const nestedError = asRecord(record?.error)
  const message =
    toOptionalString(record?.message) ??
    toOptionalString(nestedError?.message) ??
    (error instanceof Error ? error.message.trim() : undefined)

  return message && message.length > 0
    ? message
    : "Parallel search request failed."
}

function getThrownErrorCode(error: unknown): string {
  const record = asRecord(error)
  const nestedError = asRecord(record?.error)
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : typeof nestedError?.status === "number"
          ? nestedError.status
          : typeof nestedError?.statusCode === "number"
            ? nestedError.statusCode
            : undefined

  return (
    toOptionalString(record?.code) ??
    toOptionalString(record?.error) ??
    toOptionalString(nestedError?.code) ??
    toOptionalString(nestedError?.error) ??
    (status ? `HTTP_${String(status)}` : "PARALLEL_SEARCH_ERROR")
  )
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

export function createAiSdkManagedSearchTools(params: {
  parallelApiKey?: string
}): ToolSet {
  const normalizedParallelApiKey = params.parallelApiKey?.trim()
  const tools: ToolSet = {
    gateway_web_search: gateway.tools.parallelSearch({
      mode: "one-shot",
      maxResults: MANAGED_SEARCH_MAX_RESULTS,
      excerpts: {
        maxCharsPerResult: 4000,
      },
    }),
  }

  if (normalizedParallelApiKey) {
    const parallelSearchTool = createSearchTool({
      apiKey: normalizedParallelApiKey,
      mode: "agentic",
      max_results: MANAGED_SEARCH_MAX_RESULTS,
      excerpts: {
        max_chars_per_result: 2500,
      },
      description:
        "Search the live web with Parallel for fresh, LLM-optimized excerpts. Use this after Tavily is unavailable, quota-limited, rate-limited, or returns a provider error.",
    })
    type ParallelSearchExecute = NonNullable<typeof parallelSearchTool.execute>
    type ParallelSearchInput = Parameters<ParallelSearchExecute>[0]
    type ParallelSearchOptions = Parameters<ParallelSearchExecute>[1]
    const execute = parallelSearchTool.execute

    tools.parallel_search = {
      ...parallelSearchTool,
      execute: async (
        input: ParallelSearchInput,
        options: ParallelSearchOptions
      ) => {
        if (!execute) {
          return {
            error: "configuration_error",
            message: "Parallel search is not executable in this runtime.",
          }
        }

        try {
          return await execute(input, options)
        } catch (error) {
          return {
            error: getThrownErrorCode(error),
            message: getErrorMessage(error),
          }
        }
      },
    }
  }

  return tools
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
    label: getToolLabel(toolName),
    ...(query ? { query } : {}),
    operation: "search",
    provider: getProvider(toolName),
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
      provider: getProvider(toolName),
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  const errorCode = getErrorCode(output)
  if (isErrorOutput(output) && !Array.isArray(output.results)) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
      operation: "search",
      provider: getProvider(toolName),
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
    provider: getProvider(toolName),
    retryable: false,
  }
}
