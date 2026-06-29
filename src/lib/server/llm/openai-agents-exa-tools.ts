import { type Tool, tool } from "@openai/agents"
import Exa from "exa-js"
import { z } from "zod"

import { asRecord, asString, toOptionalString } from "@/lib/cast"
import { createLogger } from "@/lib/logger"
import type { MessageSource, ToolName } from "@/lib/shared"

const logger = createLogger("exa-tools")

const EXA_SEARCH_TOOL_NAME = "exa_search" as const
const EXA_GET_CONTENTS_TOOL_NAME = "exa_get_contents" as const
const EXA_SEARCH_MAX_RESULTS = 8
const EXA_SEARCH_DEFAULT_MAX_RESULTS = 5
const EXA_GET_CONTENTS_MAX_URLS = 5
const EXA_SEARCH_TEXT_MAX_CHARACTERS = 8000

const EXA_SEARCH_LABEL = "Searching the web"
const EXA_GET_CONTENTS_LABEL = "Reading pages"

type ExaToolName = Extract<
  ToolName,
  typeof EXA_SEARCH_TOOL_NAME | typeof EXA_GET_CONTENTS_TOOL_NAME
>

interface ExaToolErrorPayload {
  message: string
  code?: string
}

interface ExaSearchToolOutput {
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

interface ExaGetContentsToolOutput {
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

type ExaToolOutput = ExaSearchToolOutput | ExaGetContentsToolOutput

interface ExaToolResultPayload {
  output?: ExaToolOutput
  error?: ExaToolErrorPayload
}

interface ExaToolCallMetadata {
  callId: string
  toolName: ExaToolName
  label: string
  query?: string
  operation?: string
  provider?: string
}

interface ExaToolResultMetadata {
  callId: string
  toolName: ExaToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  errorCode?: string
  retryable?: boolean
}

const exaSearchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Focused, natural-language search query for the information you need."
    ),
  category: z
    .enum(["news", "company", "research paper", "pdf", "financial report"])
    .optional()
    .describe(
      "Bias results to a content category. Use 'news' for current events and 'financial report' for company financials; omit for a general web search."
    ),
  timeRange: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe(
      "Restrict results to a recent time window. Use for time-sensitive or 'latest' queries."
    ),
  includeDomains: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Only return results from these domains (e.g. ['sec.gov']). Omit unless the user wants specific sources."
    ),
  excludeDomains: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Exclude results from these domains."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(EXA_SEARCH_MAX_RESULTS)
    .optional()
    .describe("Maximum number of search results to return."),
})

const exaGetContentsInputSchema = z.object({
  urls: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      "Page URLs to read and extract content from. Provide URLs you already discovered via search."
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional focus for extraction — what to prioritize when reading the pages."
    ),
})

type ExaSearchCategory = z.infer<typeof exaSearchInputSchema>["category"]

function createExaClient(apiKey: string): Exa {
  return new Exa(apiKey)
}

function getToolName(value: string | undefined): ExaToolName | null {
  if (value === EXA_SEARCH_TOOL_NAME || value === EXA_GET_CONTENTS_TOOL_NAME) {
    return value
  }

  return null
}

export function isExaToolName(value: unknown): value is ExaToolName {
  return getToolName(typeof value === "string" ? value : undefined) !== null
}

function getToolLabel(toolName: ExaToolName): string {
  return toolName === EXA_SEARCH_TOOL_NAME
    ? EXA_SEARCH_LABEL
    : EXA_GET_CONTENTS_LABEL
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const TIME_RANGE_DAYS: Record<"day" | "week" | "month" | "year", number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
}

function timeRangeToStartDate(
  timeRange: "day" | "week" | "month" | "year" | undefined
): string | undefined {
  if (!timeRange) {
    return undefined
  }

  const start = new Date(Date.now() - TIME_RANGE_DAYS[timeRange] * MS_PER_DAY)
  return start.toISOString().slice(0, 10)
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

function getExaErrorPayload(error: unknown): ExaToolErrorPayload {
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
    message: message && message.length > 0 ? message : "Exa request failed.",
    ...(code ? { code } : {}),
  }
}

function toSearchOutput(query: string, response: unknown): ExaSearchToolOutput {
  const record = asRecord(response)
  const requestId = toOptionalString(record?.requestId) ?? ""
  const rawResults = Array.isArray(record?.results) ? record.results : []

  return {
    query,
    requestId,
    results: rawResults.flatMap((result) => {
      const resultRecord = asRecord(result)
      const url = asString(resultRecord?.url)?.trim()
      if (!url) {
        return []
      }

      const title = asString(resultRecord?.title)?.trim()
      const text = asString(resultRecord?.text)?.trim()
      const highlights = Array.isArray(resultRecord?.highlights)
        ? resultRecord.highlights
            .map((highlight) => asString(highlight)?.trim())
            .filter((highlight): highlight is string => Boolean(highlight))
            .join(" ")
        : undefined
      const content = text && text.length > 0 ? text : (highlights ?? "")
      const publishedDate = asString(resultRecord?.publishedDate)?.trim()
      const favicon = asString(resultRecord?.favicon)?.trim()

      return [
        {
          title: title && title.length > 0 ? title : url,
          url,
          content,
          citationMarkdown: toCitationMarkdown(url, title ?? undefined),
          ...(publishedDate ? { publishedDate } : {}),
          ...(favicon ? { favicon } : {}),
        },
      ]
    }),
  }
}

function toGetContentsOutput(
  requestedUrls: string[],
  response: unknown
): ExaGetContentsToolOutput {
  const record = asRecord(response)
  const requestId = toOptionalString(record?.requestId) ?? ""
  const rawResults = Array.isArray(record?.results) ? record.results : []

  const results = rawResults.flatMap((result) => {
    const resultRecord = asRecord(result)
    const url = asString(resultRecord?.url)?.trim()
    const rawContent = asString(resultRecord?.text)?.trim()
    if (!url || !rawContent) {
      return []
    }

    const title = asString(resultRecord?.title)?.trim()
    const favicon = asString(resultRecord?.favicon)?.trim()

    return [
      {
        url,
        rawContent,
        citationMarkdown: toCitationMarkdown(url, title ?? undefined),
        ...(favicon ? { favicon } : {}),
      },
    ]
  })

  const succeededUrls = new Set(results.map((result) => result.url))
  const failedResults = requestedUrls
    .filter((url) => !succeededUrls.has(url))
    .map((url) => ({ url, error: "No content returned." }))

  return {
    requestId,
    results,
    failedResults,
  }
}

function toSourcesFromOutput(
  toolName: ExaToolName,
  output: ExaToolOutput
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

function parseToolResultPayload(value: unknown): ExaToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  const output = normalized.output
  const error = normalized.error

  return {
    ...(asRecord(output) ? { output: output as ExaToolOutput } : {}),
    ...(asRecord(error) ? { error: error as ExaToolErrorPayload } : {}),
  }
}

// Exa rate-limits per key. The Goblins fan-out (up to 6 sub-agents searching in
// parallel) easily exceeds that, so a process-wide gate caps in-flight Exa calls
// and any 429/5xx that still slips through is retried with capped exponential
// backoff — otherwise searches surface as failed (red ✗) steps and goblins waste
// their budget retrying the same query. Kept conservative (and now Exa carries
// 100% of search load since the OpenAI web_search tool was removed).
const EXA_MAX_CONCURRENCY = 4
const EXA_MAX_RETRIES = 6
const EXA_RETRY_MAX_DELAY_MS = 6000

let exaActiveCount = 0
const exaWaiters: (() => void)[] = []

function acquireExaSlot(): Promise<void> {
  if (exaActiveCount < EXA_MAX_CONCURRENCY) {
    exaActiveCount += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    exaWaiters.push(() => {
      exaActiveCount += 1
      resolve()
    })
  })
}

function releaseExaSlot(): void {
  exaActiveCount = Math.max(0, exaActiveCount - 1)
  exaWaiters.shift()?.()
}

function getExaStatus(error: unknown): number | undefined {
  const record = asRecord(error)
  return typeof record?.status === "number"
    ? record.status
    : typeof record?.statusCode === "number"
      ? record.statusCode
      : undefined
}

function isRetriableExaError(error: unknown): boolean {
  const status = getExaStatus(error)
  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
  )
}

/**
 * Runs an Exa call under the shared concurrency gate, retrying 429/5xx with
 * capped exponential backoff. Logs the final failure (the red ✗ the user sees)
 * with its HTTP status so rate-limiting (429) is visible in the runtime logs.
 * `context` labels the call (tool + query) in those logs.
 */
async function runExaRequest<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  await acquireExaSlot()
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn()
      } catch (error) {
        const status = getExaStatus(error)
        if (attempt >= EXA_MAX_RETRIES || !isRetriableExaError(error)) {
          logger.warn("Exa request failed.", {
            context,
            status,
            attempts: attempt + 1,
            retriable: isRetriableExaError(error),
            errorCode: getExaErrorPayload(error).code,
          })
          throw error
        }
        const delayMs =
          Math.min(EXA_RETRY_MAX_DELAY_MS, 400 * Math.pow(2, attempt)) +
          Math.random() * 300
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  } finally {
    releaseExaSlot()
  }
}

/**
 * Builds the agent's web tools for the OpenAI Agents SDK: the Exa search/read
 * function tools when an Exa key is configured. Exa is the only web-search
 * provider — returns an empty toolset (the agent runs tool-less) when no Exa key
 * is set.
 */
export function createOpenAiAgentsExaTools(apiKey?: string): Tool[] {
  const tools: Tool[] = []

  const normalized = apiKey?.trim()
  if (!normalized) {
    return tools
  }

  const client = createExaClient(normalized)

  tools.push(
    tool({
      name: EXA_SEARCH_TOOL_NAME,
      description:
        "Search the live web for fresh, multi-source retrieval. Use this when you need up-to-date external information or need to discover relevant pages before reading them in detail.",
      parameters: exaSearchInputSchema,
      execute: async (input) => {
        try {
          const maxResults = Math.min(
            EXA_SEARCH_MAX_RESULTS,
            Math.max(1, input.maxResults ?? EXA_SEARCH_DEFAULT_MAX_RESULTS)
          )
          const startPublishedDate = timeRangeToStartDate(input.timeRange)
          const category: ExaSearchCategory = input.category

          const response = await runExaRequest(
            () =>
              client.search(input.query, {
                type: "auto",
                numResults: maxResults,
                contents: {
                  text: { maxCharacters: EXA_SEARCH_TEXT_MAX_CHARACTERS },
                },
                ...(category ? { category } : {}),
                ...(startPublishedDate ? { startPublishedDate } : {}),
                ...(input.includeDomains && input.includeDomains.length > 0
                  ? { includeDomains: input.includeDomains }
                  : {}),
                ...(input.excludeDomains && input.excludeDomains.length > 0
                  ? { excludeDomains: input.excludeDomains }
                  : {}),
              }),
            `exa_search:${input.query}`
          )

          return {
            output: toSearchOutput(input.query, response),
          } satisfies ExaToolResultPayload
        } catch (error) {
          return {
            error: getExaErrorPayload(error),
          } satisfies ExaToolResultPayload
        }
      },
    }),
    tool({
      name: EXA_GET_CONTENTS_TOOL_NAME,
      description:
        "Read and extract content from specific URLs. Use this after you already have one or more pages and need to inspect or summarize their contents.",
      parameters: exaGetContentsInputSchema,
      execute: async (input) => {
        try {
          const urls = Array.from(
            new Set(input.urls.map((url) => url.trim()).filter((url) => url))
          ).slice(0, EXA_GET_CONTENTS_MAX_URLS)

          const response = await runExaRequest(
            () =>
              client.getContents(urls, {
                text: true,
                livecrawl: "fallback",
              }),
            `exa_get_contents:${String(urls.length)} urls`
          )

          return {
            output: toGetContentsOutput(urls, response),
          } satisfies ExaToolResultPayload
        } catch (error) {
          return {
            error: getExaErrorPayload(error),
          } satisfies ExaToolResultPayload
        }
      },
    })
  )

  return tools
}

export function getExaToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): ExaToolCallMetadata | null {
  const toolName = getToolName(part?.toolName)
  if (!toolName || !part) {
    return null
  }

  const inputRecord = asRecord(part.input)
  const query =
    toolName === EXA_SEARCH_TOOL_NAME
      ? toOptionalString(inputRecord?.query)
      : undefined

  return {
    callId: part.toolCallId,
    toolName,
    label: getToolLabel(toolName),
    ...(query ? { query } : {}),
    operation: toolName === EXA_SEARCH_TOOL_NAME ? "search" : "get_contents",
    provider: "exa",
  }
}

export function getExaToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): ExaToolResultMetadata | null {
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
      operation: toolName === EXA_SEARCH_TOOL_NAME ? "search" : "get_contents",
      provider: "exa",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName,
      status: "error",
      sources: [],
      operation: toolName === EXA_SEARCH_TOOL_NAME ? "search" : "get_contents",
      provider: "exa",
      errorCode: payload.error.code,
      retryable: true,
    }
  }

  return {
    callId: part.toolCallId,
    toolName,
    status: "success",
    sources: payload.output
      ? toSourcesFromOutput(toolName, payload.output)
      : [],
    operation: toolName === EXA_SEARCH_TOOL_NAME ? "search" : "get_contents",
    provider: "exa",
    retryable: false,
  }
}
