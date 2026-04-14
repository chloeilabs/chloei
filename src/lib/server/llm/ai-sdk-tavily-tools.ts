import {
  tavily,
  type TavilyClient,
  type TavilyExtractOptions,
  type TavilyExtractResponse,
  type TavilySearchOptions,
  type TavilySearchResponse,
} from "@tavily/core"
import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ToolName } from "@/lib/shared"

const TAVILY_SEARCH_TOOL_NAME = "tavily_search" as const
const TAVILY_EXTRACT_TOOL_NAME = "tavily_extract" as const
const TAVILY_SEARCH_MAX_RESULTS = 8
const TAVILY_SEARCH_DEFAULT_MAX_RESULTS = 5
const TAVILY_EXTRACT_MAX_URLS = 5

const AI_SDK_TAVILY_SEARCH_LABEL = "Searching with Tavily"
const AI_SDK_TAVILY_EXTRACT_LABEL = "Reading pages"

type AiSdkTavilyToolName = Extract<
  ToolName,
  typeof TAVILY_SEARCH_TOOL_NAME | typeof TAVILY_EXTRACT_TOOL_NAME
>

interface TavilyToolErrorPayload {
  message: string
  code?: string
}

interface TavilySearchToolOutput {
  query: string
  requestId: string
  results: {
    title: string
    url: string
    content: string
    citationMarkdown: string
    publishedDate?: string
    favicon?: string
  }[]
}

interface TavilyExtractToolOutput {
  requestId: string
  results: {
    url: string
    rawContent: string
    citationMarkdown: string
    favicon?: string
  }[]
  failedResults: {
    url: string
    error: string
  }[]
}

type TavilyToolOutput = TavilySearchToolOutput | TavilyExtractToolOutput

interface TavilyToolResultPayload {
  output?: TavilyToolOutput
  error?: TavilyToolErrorPayload
}

interface AiSdkTavilyToolCallMetadata {
  callId: string
  toolName: AiSdkTavilyToolName
  label: string
  query?: string
}

interface AiSdkTavilyToolResultMetadata {
  callId: string
  toolName: AiSdkTavilyToolName
  status: "success" | "error"
  sources: MessageSource[]
}

const tavilySearchInputSchema = z.object({
  query: z.string().trim().min(1),
  topic: z.enum(["general", "news", "finance"]).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  includeDomains: z.array(z.string().trim().min(1)).optional(),
  excludeDomains: z.array(z.string().trim().min(1)).optional(),
  country: z.string().trim().min(1).optional(),
  maxResults: z.number().int().min(1).max(TAVILY_SEARCH_MAX_RESULTS).optional(),
})

const tavilyExtractInputSchema = z.object({
  urls: z.array(z.string().trim().min(1)).min(1),
  query: z.string().trim().min(1).optional(),
  extractDepth: z.enum(["basic", "advanced"]).optional(),
  format: z.enum(["markdown", "text"]).optional(),
})

function createTavilyClient(apiKey: string): TavilyClient {
  return tavily({ apiKey })
}

function getToolName(value: string | undefined): AiSdkTavilyToolName | null {
  if (value === TAVILY_SEARCH_TOOL_NAME || value === TAVILY_EXTRACT_TOOL_NAME) {
    return value
  }

  return null
}

export function isAiSdkTavilyToolName(
  value: unknown
): value is AiSdkTavilyToolName {
  return getToolName(typeof value === "string" ? value : undefined) !== null
}

function getToolLabel(toolName: AiSdkTavilyToolName): string {
  return toolName === TAVILY_SEARCH_TOOL_NAME
    ? AI_SDK_TAVILY_SEARCH_LABEL
    : AI_SDK_TAVILY_EXTRACT_LABEL
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  if (!normalized) {
    return undefined
  }

  return normalized
}

const MULTIPART_PUBLIC_SUFFIX_PREFIXES = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "net",
  "org",
])

function toTitleCaseWord(word: string): string {
  if (word.length === 0) {
    return word
  }

  if (/^[a-z]{2,5}$/i.test(word)) {
    return word.toUpperCase()
  }

  return `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`
}

function getSiteNameFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").trim()
    if (!hostname) {
      return null
    }

    const parts = hostname.split(".").filter((part) => part.length > 0)
    if (parts.length === 0) {
      return null
    }

    let candidate = parts[parts.length - 2] ?? parts[0]
    const publicSuffixPrefix = parts[parts.length - 2]
    if (
      parts.length >= 3 &&
      publicSuffixPrefix &&
      MULTIPART_PUBLIC_SUFFIX_PREFIXES.has(publicSuffixPrefix) &&
      (parts[parts.length - 1]?.length ?? 0) === 2
    ) {
      candidate = parts[parts.length - 3] ?? candidate
    }

    if (!candidate) {
      return null
    }

    const normalized = candidate
      .split(/[-_]+/g)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map(toTitleCaseWord)
      .join(" ")
      .trim()

    return normalized || null
  } catch {
    return null
  }
}

function getSiteNameFromTitle(title?: string): string | null {
  const normalized = title?.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return null
  }

  for (const separator of [" | ", " - ", " — ", " – ", " • ", " · "]) {
    if (!normalized.includes(separator)) {
      continue
    }

    const parts = normalized
      .split(separator)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)

    if (parts.length < 2) {
      continue
    }

    const candidate = parts[parts.length - 1]
    if (candidate && candidate.length <= 60) {
      return candidate
    }
  }

  return null
}

function getCitationLabel(url: string, title?: string): string {
  const siteNameFromTitle = getSiteNameFromTitle(title)
  if (siteNameFromTitle) {
    return siteNameFromTitle
  }

  const siteNameFromUrl = getSiteNameFromUrl(url)
  if (siteNameFromUrl) {
    return siteNameFromUrl
  }

  const normalizedTitle = title?.replace(/\s+/g, " ").trim()
  return normalizedTitle && normalizedTitle.length > 0 ? normalizedTitle : url
}

function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
}

function escapeMarkdownLinkTitle(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function toCitationMarkdown(url: string, title?: string): string {
  const label = escapeMarkdownLinkLabel(getCitationLabel(url, title))
  const normalizedTitle = title?.replace(/\s+/g, " ").trim()

  if (normalizedTitle) {
    return `[${label}](<${url}> "${escapeMarkdownLinkTitle(normalizedTitle)}")`
  }

  return `[${label}](<${url}>)`
}

function getTavilyErrorPayload(error: unknown): TavilyToolErrorPayload {
  const record = asRecord(error)
  const message =
    asString(record?.message)?.trim() ??
    (error instanceof Error ? error.message.trim() : "")

  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : undefined

  const code =
    toOptionalString(record?.code) ??
    (status ? `HTTP_${String(status)}` : undefined)

  return {
    message: message && message.length > 0 ? message : "Tavily request failed.",
    ...(code ? { code } : {}),
  }
}

function toSearchOutput(
  response: TavilySearchResponse
): TavilySearchToolOutput {
  return {
    query: response.query,
    requestId: response.requestId,
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      citationMarkdown: toCitationMarkdown(result.url, result.title),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      ...(result.favicon ? { favicon: result.favicon } : {}),
    })),
  }
}

function toExtractOutput(
  response: TavilyExtractResponse
): TavilyExtractToolOutput {
  return {
    requestId: response.requestId,
    results: response.results.map((result) => ({
      url: result.url,
      rawContent: result.rawContent,
      citationMarkdown: toCitationMarkdown(result.url),
      ...(result.favicon ? { favicon: result.favicon } : {}),
    })),
    failedResults: response.failedResults.map((result) => ({
      url: result.url,
      error: result.error,
    })),
  }
}

function toSourcesFromOutput(
  toolName: AiSdkTavilyToolName,
  output: TavilyToolOutput
): MessageSource[] {
  const normalizedRequestId = output.requestId.trim()
  const requestId =
    normalizedRequestId.length > 0
      ? normalizedRequestId
      : `${toolName}-${crypto.randomUUID()}`

  return output.results
    .map((result, index) => {
      const record = asRecord(result)
      const url = asString(record?.url)?.trim()
      if (!url) {
        return null
      }

      const normalizedTitle = asString(record?.title)?.trim()
      const title =
        normalizedTitle && normalizedTitle.length > 0 ? normalizedTitle : url

      return {
        id: `${toolName}-${requestId}-${String(index)}`,
        url,
        title,
      }
    })
    .filter((source): source is MessageSource => source !== null)
}

function parseToolResultPayload(
  value: unknown
): TavilyToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  const output = normalized.output
  const error = normalized.error

  return {
    ...(asRecord(output) ? { output: output as TavilyToolOutput } : {}),
    ...(asRecord(error) ? { error: error as TavilyToolErrorPayload } : {}),
  }
}

export function createAiSdkTavilyTools(apiKey?: string) {
  const normalized = apiKey?.trim()
  if (!normalized) {
    return {}
  }

  const client = createTavilyClient(normalized)

  return {
    tavily_search: tool({
      description:
        "Search the live web with Tavily for fresh, multi-source retrieval. Use this when you need up-to-date external information or need to discover relevant pages before reading them in detail.",
      inputSchema: tavilySearchInputSchema,
      execute: async (input) => {
        try {
          const maxResults = Math.min(
            TAVILY_SEARCH_MAX_RESULTS,
            Math.max(1, input.maxResults ?? TAVILY_SEARCH_DEFAULT_MAX_RESULTS)
          )
          const options: TavilySearchOptions = {
            searchDepth: "advanced",
            includeFavicon: true,
            includeRawContent: false,
            topic: input.topic ?? "general",
            maxResults,
            ...(input.timeRange ? { timeRange: input.timeRange } : {}),
            ...(input.includeDomains && input.includeDomains.length > 0
              ? { includeDomains: input.includeDomains }
              : {}),
            ...(input.excludeDomains && input.excludeDomains.length > 0
              ? { excludeDomains: input.excludeDomains }
              : {}),
            ...(input.country ? { country: input.country } : {}),
          }

          const response = await client.search(input.query, options)
          return {
            output: toSearchOutput(response),
          } satisfies TavilyToolResultPayload
        } catch (error) {
          return {
            error: getTavilyErrorPayload(error),
          } satisfies TavilyToolResultPayload
        }
      },
    }),
    tavily_extract: tool({
      description:
        "Read and extract content from specific URLs with Tavily. Use this after you already have one or more pages and need to inspect or summarize their contents.",
      inputSchema: tavilyExtractInputSchema,
      execute: async (input) => {
        try {
          const options: TavilyExtractOptions = {
            extractDepth: input.extractDepth ?? "advanced",
            format: input.format ?? "markdown",
            ...(input.query ? { query: input.query } : {}),
          }

          const response = await client.extract(
            Array.from(
              new Set(input.urls.map((url) => url.trim()).filter((url) => url))
            ).slice(0, TAVILY_EXTRACT_MAX_URLS),
            options
          )

          return {
            output: toExtractOutput(response),
          } satisfies TavilyToolResultPayload
        } catch (error) {
          return {
            error: getTavilyErrorPayload(error),
          } satisfies TavilyToolResultPayload
        }
      },
    }),
  }
}

export function getAiSdkTavilyToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkTavilyToolCallMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const inputRecord = asRecord(part.input)
  const query =
    toolName === TAVILY_SEARCH_TOOL_NAME
      ? toOptionalString(inputRecord?.query)
      : undefined

  return {
    callId: part.toolCallId,
    toolName,
    label: getToolLabel(toolName),
    ...(query ? { query } : {}),
  }
}

export function getAiSdkTavilyToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkTavilyToolResultMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const payload = parseToolResultPayload(part.output)
  if (!payload) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
    }
  }

  return {
    callId: part.toolCallId,
    toolName,
    status: "success",
    sources: payload.output
      ? toSourcesFromOutput(toolName, payload.output)
      : [],
  }
}
