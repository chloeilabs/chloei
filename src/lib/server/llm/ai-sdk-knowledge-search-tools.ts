import { randomUUID } from "node:crypto"

import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import { hashUserId } from "@/lib/server/privacy"
import type { MessageSource, ToolName } from "@/lib/shared"

const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge_search" as const
const KNOWLEDGE_SEARCH_LABEL = "Searching knowledge"
const DEFAULT_INDEX_NAME = "chloei-knowledge"
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 8
const MAX_SNIPPET_CHARS = 2_000

type KnowledgeSearchToolName = Extract<
  ToolName,
  typeof KNOWLEDGE_SEARCH_TOOL_NAME
>

interface KnowledgeSearchContent {
  [key: string]: unknown
  title?: string
  text?: string
  sourceUrl?: string
  artifactUrl?: string
  sourceType?: string
  asOfDate?: string
}

interface KnowledgeSearchMetadata {
  [key: string]: unknown
  ownerKey?: string
  userId?: string
  ownerId?: string
  visibility?: "private" | "shared" | "public"
  corpus?: string
  title?: string
  sourceUrl?: string
  artifactUrl?: string
  sourceType?: string
  asOfDate?: string
  documentId?: string
  chunkId?: string
}

interface KnowledgeSearchResult {
  id: string
  title: string
  snippet: string
  sourceUrl?: string
  artifactUrl?: string
  sourceType: string
  asOfDate?: string
  corpus?: string
  score: number
  citationMarkdown: string
}

interface KnowledgeSearchToolOutput {
  query: string
  requestId: string
  results: KnowledgeSearchResult[]
}

interface KnowledgeSearchToolErrorPayload {
  message: string
  code?: string
}

interface KnowledgeSearchToolResultPayload {
  output?: KnowledgeSearchToolOutput
  error?: KnowledgeSearchToolErrorPayload
}

interface UpstashSearchDocument {
  id: string
  content?: KnowledgeSearchContent
  metadata?: KnowledgeSearchMetadata
  score: number
}

interface AiSdkKnowledgeSearchToolCallMetadata {
  callId: string
  toolName: KnowledgeSearchToolName
  label: string
  query?: string
  operation?: string
  provider?: string
}

interface AiSdkKnowledgeSearchToolResultMetadata {
  callId: string
  toolName: KnowledgeSearchToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  errorCode?: string
  retryable?: boolean
}

interface CreateAiSdkKnowledgeSearchToolsOptions {
  enabled: boolean
  userId?: string
  indexName?: string
}

const knowledgeSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  corpus: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
})
const knowledgeSearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  sourceUrl: z.string().optional(),
  artifactUrl: z.string().optional(),
  sourceType: z.string(),
  asOfDate: z.string().optional(),
  corpus: z.string().optional(),
  score: z.number(),
  citationMarkdown: z.string(),
})
const knowledgeSearchToolOutputSchema = z.object({
  query: z.string(),
  requestId: z.string(),
  results: z.array(knowledgeSearchResultSchema),
})
const knowledgeSearchToolErrorPayloadSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
})

async function getConfiguredSearchClient(): Promise<UpstashSearchClient | null> {
  const url = process.env.UPSTASH_SEARCH_REST_URL?.trim()
  const token = process.env.UPSTASH_SEARCH_REST_TOKEN?.trim()
  if (!url || !token) {
    return null
  }

  const { Search } = await import("@upstash/search")
  return new Search({
    url,
    token,
    enableTelemetry: process.env.UPSTASH_DISABLE_TELEMETRY !== "1",
  })
}

function truncateSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= MAX_SNIPPET_CHARS) {
    return normalized
  }

  return `${normalized.slice(0, MAX_SNIPPET_CHARS)}...`
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  if (!normalized) {
    return undefined
  }

  return normalized
}

function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
}

function toCitationMarkdown(result: { title: string; url?: string }): string {
  const label = escapeMarkdownLinkLabel(result.title)
  return result.url ? `[${label}](<${result.url}>)` : label
}

export function buildKnowledgeSearchUserScopeFilter(
  userId: string,
  corpus?: string
) {
  const ownerKey = hashUserId(userId).replace("sha256:", "")
  const scopeFilter = {
    OR: [
      { "@metadata.ownerKey": { equals: ownerKey } },
      { "@metadata.ownerId": { equals: userId } },
      { "@metadata.userId": { equals: userId } },
      { "@metadata.visibility": { equals: "public" } },
    ],
  }

  if (!corpus) {
    return scopeFilter
  }

  return {
    AND: [scopeFilter, { "@metadata.corpus": { equals: corpus } }],
  }
}

function toKnowledgeSearchResults(
  output: readonly UpstashSearchDocument[]
): KnowledgeSearchResult[] {
  return output.map((document) => {
    const content = document.content ?? {}
    const metadata = document.metadata ?? {}
    const title =
      toOptionalString(metadata.title) ??
      toOptionalString(content.title) ??
      `Knowledge result ${document.id}`
    const sourceUrl =
      toOptionalString(metadata.sourceUrl) ??
      toOptionalString(content.sourceUrl)
    const artifactUrl =
      toOptionalString(metadata.artifactUrl) ??
      toOptionalString(content.artifactUrl)
    const url = sourceUrl ?? artifactUrl
    const sourceType =
      toOptionalString(metadata.sourceType) ??
      toOptionalString(content.sourceType) ??
      "knowledge"

    return {
      id: document.id,
      title,
      snippet: truncateSnippet(toOptionalString(content.text) ?? ""),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(artifactUrl ? { artifactUrl } : {}),
      sourceType,
      ...((toOptionalString(metadata.asOfDate) ??
      toOptionalString(content.asOfDate))
        ? {
            asOfDate:
              toOptionalString(metadata.asOfDate) ??
              toOptionalString(content.asOfDate),
          }
        : {}),
      ...(toOptionalString(metadata.corpus)
        ? { corpus: toOptionalString(metadata.corpus) }
        : {}),
      score: document.score,
      citationMarkdown: toCitationMarkdown({ title, ...(url ? { url } : {}) }),
    }
  })
}

function getErrorPayload(error: unknown): KnowledgeSearchToolErrorPayload {
  const record = asRecord(error)
  const message =
    asString(record?.message)?.trim() ??
    (error instanceof Error ? error.message.trim() : "")
  const code = toOptionalString(record?.code)

  return {
    message:
      message && message.length > 0
        ? message
        : "Knowledge search request failed.",
    ...(code ? { code } : {}),
  }
}

function parseToolResultPayload(
  value: unknown
): KnowledgeSearchToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  const output = knowledgeSearchToolOutputSchema.safeParse(normalized.output)
  const error = knowledgeSearchToolErrorPayloadSchema.safeParse(
    normalized.error
  )
  if (!output.success && !error.success) {
    return null
  }

  return {
    ...(output.success ? { output: output.data } : {}),
    ...(error.success ? { error: error.data } : {}),
  }
}

function toSourcesFromOutput(
  output: KnowledgeSearchToolOutput
): MessageSource[] {
  return output.results.flatMap((result, index) => {
    const url = result.sourceUrl ?? result.artifactUrl
    if (!url) {
      return []
    }

    return [
      {
        id: `${KNOWLEDGE_SEARCH_TOOL_NAME}-${output.requestId}-${String(index)}`,
        url,
        title: result.title,
      },
    ]
  })
}

export function isAiSdkKnowledgeSearchToolName(
  value: unknown
): value is KnowledgeSearchToolName {
  return value === KNOWLEDGE_SEARCH_TOOL_NAME
}

export function createAiSdkKnowledgeSearchTools(
  options: CreateAiSdkKnowledgeSearchToolsOptions
) {
  const hasSearchCredentials = Boolean(
    process.env.UPSTASH_SEARCH_REST_URL?.trim() &&
    process.env.UPSTASH_SEARCH_REST_TOKEN?.trim()
  )
  if (!options.enabled || !options.userId || !hasSearchCredentials) {
    return {}
  }

  const indexName =
    toOptionalString(options.indexName) ??
    toOptionalString(process.env.UPSTASH_SEARCH_INDEX) ??
    DEFAULT_INDEX_NAME
  const userId = options.userId

  return {
    knowledge_search: tool({
      description:
        "Search Chloei's governed internal knowledge store for user-authorized policies, research notes, uploaded documents, transcripts, and static reference material. Do not use this for live market prices, filings, macro releases, news, or other current facts; use finance_data, SEC, or Tavily for live/current facts.",
      inputSchema: knowledgeSearchInputSchema,
      execute: async (input) => {
        try {
          const client = await getConfiguredSearchClient()
          if (!client) {
            return {
              error: {
                message: "Upstash Search is not configured.",
                code: "KNOWLEDGE_SEARCH_UNCONFIGURED",
              },
            } satisfies KnowledgeSearchToolResultPayload
          }

          const index = client.index(indexName)
          const filter = buildKnowledgeSearchUserScopeFilter(
            userId,
            input.corpus
          )
          const results = await index.search({
            query: input.query,
            limit: input.limit ?? DEFAULT_LIMIT,
            filter,
            semanticWeight: 0.75,
            inputEnrichment: true,
          })

          return {
            output: {
              query: input.query,
              requestId: randomUUID(),
              results: toKnowledgeSearchResults(results),
            },
          } satisfies KnowledgeSearchToolResultPayload
        } catch (error) {
          return {
            error: getErrorPayload(error),
          } satisfies KnowledgeSearchToolResultPayload
        }
      },
    }),
  }
}

export function getAiSdkKnowledgeSearchToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkKnowledgeSearchToolCallMetadata | null {
  if (part?.toolName !== KNOWLEDGE_SEARCH_TOOL_NAME) {
    return null
  }

  return {
    callId: part.toolCallId,
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
    label: KNOWLEDGE_SEARCH_LABEL,
    ...(toOptionalString(asRecord(part.input)?.query)
      ? { query: toOptionalString(asRecord(part.input)?.query) }
      : {}),
    operation: "search",
    provider: "upstash_search",
  }
}

export function getAiSdkKnowledgeSearchToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkKnowledgeSearchToolResultMetadata | null {
  if (part?.toolName !== KNOWLEDGE_SEARCH_TOOL_NAME) {
    return null
  }

  const payload = parseToolResultPayload(part.output)
  if (!payload) {
    return {
      callId: part.toolCallId,
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
      status: "error",
      sources: [],
      operation: "search",
      provider: "upstash_search",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
      status: "error",
      sources: [],
      operation: "search",
      provider: "upstash_search",
      errorCode: payload.error.code,
      retryable: true,
    }
  }

  return {
    callId: part.toolCallId,
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
    status: "success",
    sources: payload.output ? toSourcesFromOutput(payload.output) : [],
    operation: "search",
    provider: "upstash_search",
    retryable: false,
  }
}
interface UpstashSearchClient {
  index(indexName: string): {
    search(params: {
      query: string
      limit?: number
      filter?: unknown
      semanticWeight?: number
      inputEnrichment?: boolean
    }): Promise<UpstashSearchDocument[]>
  }
}
