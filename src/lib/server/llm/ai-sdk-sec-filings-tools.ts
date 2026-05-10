import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ToolName } from "@/lib/shared"

import {
  classifyFinanceDataRetry,
  fetchJsonWithRetry,
  fetchTextWithRetry,
} from "./finance-data/retry"

const SEC_FILINGS_TOOL_NAME = "sec_filings" as const
const SEC_FILINGS_LABEL = "Searching SEC filings"
const SEC_COMPANY_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions"
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
const SEC_ARCHIVE_HOSTNAMES = new Set(["sec.gov", "www.sec.gov"])
const DEFAULT_MAX_CHARS = 25_000
const MAX_TEXT_CHARS = 80_000
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const DEFAULT_SNIPPET_LIMIT = 6
const MAX_SNIPPET_LIMIT = 12

type SecFilingsToolName = Extract<ToolName, typeof SEC_FILINGS_TOOL_NAME>
type SecFilingsOperation =
  | "company_search"
  | "filing_search"
  | "document_fetch"
  | "section_extract"
  | "table_extract"
  | "retrieve_information"

interface SecFilingsToolConfig {
  fetchImpl?: typeof fetch
  secUserAgent?: string
}

interface SecCompanyTickerRow {
  cik: string
  ticker: string
  title: string
}

interface SecFilingRecord {
  accessionNumber: string
  filingDate: string
  form: string
  primaryDocument: string
  reportDate?: string
  primaryDocDescription?: string
  url: string
}

interface ResolvedSecCompany {
  attempts: number
  cik: string
  source?: MessageSource
  ticker?: string
  title?: string
}

interface ResolvedFilingDocument {
  attempts: number
  filing?: SecFilingRecord
  sources: MessageSource[]
  url: string
}

interface ParsedSecArchiveUrl {
  accessionNumber: string
  cik: string
}

interface FetchedFilingDocument extends ResolvedFilingDocument {
  rawText: string
}

interface ParsedHtmlTable {
  context?: string
  index: number
  rows: string[][]
  text: string
}

interface SecFilingsToolOutput {
  operation: SecFilingsOperation
  provider: "sec"
  data: unknown
  sources: MessageSource[]
  durationMs: number
  attempts: number
}

interface SecFilingsToolErrorPayload {
  message: string
  code: string
  operation: SecFilingsOperation
  provider: "sec"
  retryable: boolean
  attempts: number
  durationMs: number
}

interface SecFilingsToolResultPayload {
  output?: SecFilingsToolOutput
  error?: SecFilingsToolErrorPayload
}

interface AiSdkSecFilingsToolCallMetadata {
  callId: string
  toolName: SecFilingsToolName
  label: string
  query?: string
  operation?: string
  provider?: string
  attempt?: number
}

interface AiSdkSecFilingsToolResultMetadata {
  callId: string
  toolName: SecFilingsToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

const secFilingsInputSchema = z.object({
  operation: z.enum([
    "company_search",
    "filing_search",
    "document_fetch",
    "section_extract",
    "table_extract",
    "retrieve_information",
  ]),
  query: z.string().trim().min(1).max(1_000).optional(),
  symbol: z.string().trim().min(1).max(40).optional(),
  cik: z.string().trim().min(1).max(20).optional(),
  forms: z.array(z.string().trim().min(1).max(20)).max(12).optional(),
  accessionNumber: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "SEC accession number for a specific filing, such as 0001065280-25-000044. If provided, the tool resolves that exact filing instead of the latest filing."
    )
    .optional(),
  primaryDocument: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe(
      "Optional SEC primary document filename, such as nflx-20241231.htm. The tool can resolve this from accessionNumber when omitted."
    )
    .optional(),
  url: z
    .url()
    .describe(
      "Optional direct SEC EDGAR archive document URL. Must be an https://www.sec.gov/Archives/edgar/data/... filing document URL."
    )
    .optional(),
  item: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      "SEC item label or filing heading to extract, such as Item 7, Item 5, or Issuer Purchases of Equity Securities. For 10-K issuer repurchase tables, prefer Item 5 or the heading Issuer Purchases of Equity Securities; for 10-Q issuer repurchase tables, prefer Part II Item 2."
    )
    .optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
})

type SecFilingsToolInput = z.infer<typeof secFilingsInputSchema>

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function getConfiguredSecUserAgent(value: string | undefined): string {
  const normalized = value?.trim()
  return normalized && normalized.length > 0
    ? normalized
    : "Chloei sec_filings research contact@example.com"
}

function normalizeLimit(input: SecFilingsToolInput, fallback = DEFAULT_LIMIT) {
  return Math.max(1, Math.min(MAX_LIMIT, input.limit ?? fallback))
}

function normalizeMaxChars(input: SecFilingsToolInput): number {
  return Math.max(
    500,
    Math.min(MAX_TEXT_CHARS, input.maxChars ?? DEFAULT_MAX_CHARS)
  )
}

function normalizeCik(cik: string): string {
  const digits = cik.replace(/\D/g, "")
  if (!digits) {
    throw Object.assign(new Error("A numeric CIK is required."), {
      code: "INVALID_INPUT",
      retryable: false,
    })
  }

  return digits.padStart(10, "0")
}

function normalizeTickerSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

function normalizeAccessionNumber(accessionNumber: string): string {
  return accessionNumber.trim().replace(/\s+/g, "")
}

function normalizeAccessionForCompare(accessionNumber: string): string {
  return normalizeAccessionNumber(accessionNumber).replaceAll("-", "")
}

function deriveCikFromAccession(accessionNumber: string): string | undefined {
  const normalized = normalizeAccessionNumber(accessionNumber)
  const match =
    /^(\d{10})-\d{2}-\d{6}$/.exec(normalized) ??
    /^(\d{10})\d{8}$/.exec(normalized)
  return match?.[1] ? normalizeCik(match[1]) : undefined
}

function buildSecCompanyTickersUrl(): URL {
  return new URL(SEC_COMPANY_TICKERS_URL)
}

function buildSecSubmissionsUrl(cik: string): URL {
  return new URL(
    `${SEC_COMPANY_SUBMISSIONS_BASE_URL}/CIK${normalizeCik(cik)}.json`
  )
}

function buildSecFilingUrl(params: {
  cik: string
  accessionNumber: string
  primaryDocument: string
}): string {
  const cikNumber = Number(normalizeCik(params.cik))
  const accessionDirectory = params.accessionNumber.replaceAll("-", "")
  const primaryDocument = params.primaryDocument.trim().replace(/^\/+/, "")

  return `https://www.sec.gov/Archives/edgar/data/${String(cikNumber)}/${accessionDirectory}/${primaryDocument}`
}

function parseSecArchiveUrl(value: string): ParsedSecArchiveUrl | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !SEC_ARCHIVE_HOSTNAMES.has(url.hostname.toLowerCase())
  ) {
    return null
  }

  const match = /^\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/([^/]+)$/i.exec(
    url.pathname
  )
  const accession = match?.[2]
  const documentName = match?.[3]
  if (
    !match?.[1] ||
    !accession ||
    !documentName ||
    documentName.includes("..") ||
    /%2f|%5c/i.test(documentName)
  ) {
    return null
  }

  return {
    cik: normalizeCik(match[1]),
    accessionNumber: `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`,
  }
}

function createSecSourceId(
  parts: readonly string[],
  sourceUrl: string
): string {
  let hash = 0
  for (let index = 0; index < sourceUrl.length; index += 1) {
    hash = (hash * 31 + sourceUrl.charCodeAt(index)) >>> 0
  }

  return `${SEC_FILINGS_TOOL_NAME}-${parts.join("-")}-${hash.toString(36)}`
}

function createSecSource(
  parts: readonly string[],
  url: string,
  title: string
): MessageSource {
  return {
    id: createSecSourceId(parts, url),
    url,
    title,
  } satisfies MessageSource
}

function requireField(
  input: SecFilingsToolInput,
  field: keyof SecFilingsToolInput
): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(
      new Error(`${input.operation} requires \`${field}\`.`),
      {
        code: "INVALID_INPUT",
        retryable: false,
      }
    )
  }

  return value.trim()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(?:p|div|section|article|tr|table|h[1-6]|li)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
    }
  }

  return {
    text: `${value.slice(0, maxChars).trimEnd()}\n\n[SEC filing text truncated by Chloei.]`,
    truncated: true,
  }
}

function toSecCompanyTickerRows(value: unknown): SecCompanyTickerRow[] {
  const record = asRecord(value)
  if (!record) {
    return []
  }

  return Object.values(record).flatMap((entry) => {
    const row = asRecord(entry)
    const ticker = toOptionalString(row?.ticker)
    const title = toOptionalString(row?.title)
    const cik =
      typeof row?.cik_str === "number"
        ? String(row.cik_str)
        : toOptionalString(row?.cik_str)

    if (!ticker || !title || !cik) {
      return []
    }

    return [
      {
        cik: normalizeCik(cik),
        ticker,
        title,
      },
    ]
  })
}

async function fetchSecTickerRows(config: {
  fetchImpl: typeof fetch
  secUserAgent?: string
}) {
  const url = buildSecCompanyTickersUrl()
  const response = await fetchJsonWithRetry({
    url,
    provider: "sec",
    headers: {
      Accept: "application/json",
      "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
    },
    fetchImpl: config.fetchImpl,
  })

  if (!response.ok) {
    throw Object.assign(new Error(response.message), {
      code: response.code,
      retryable: response.retryable,
      attempts: response.attempts,
    })
  }

  return {
    rows: toSecCompanyTickerRows(response.data),
    url,
    attempts: response.attempts,
  }
}

async function resolveSecCompany(config: {
  input: SecFilingsToolInput
  fetchImpl: typeof fetch
  secUserAgent?: string
}): Promise<ResolvedSecCompany> {
  const cik = config.input.cik
  if (cik) {
    return {
      cik: normalizeCik(cik),
      attempts: 0,
    }
  }

  if (config.input.accessionNumber && !config.input.symbol) {
    const cikFromAccession = deriveCikFromAccession(
      config.input.accessionNumber
    )
    if (cikFromAccession) {
      return {
        cik: cikFromAccession,
        attempts: 0,
      }
    }
  }

  const symbol = requireField(config.input, "symbol")
  const { rows, url, attempts } = await fetchSecTickerRows(config)
  const normalizedSymbol = normalizeTickerSymbol(symbol)
  const match = rows.find(
    (row) => row.ticker.toUpperCase() === normalizedSymbol
  )
  if (!match) {
    throw Object.assign(
      new Error(`Unable to resolve SEC CIK for symbol ${normalizedSymbol}.`),
      {
        code: "SEC_CIK_NOT_FOUND",
        retryable: false,
        attempts,
      }
    )
  }

  return {
    ...match,
    source: createSecSource(
      ["company_tickers"],
      url.toString(),
      "SEC company tickers"
    ),
    attempts,
  }
}

function normalizeForms(input: SecFilingsToolInput): string[] {
  const forms = input.forms?.length ? input.forms : ["10-K", "10-Q", "8-K"]
  return forms.map((form) => form.trim().toUpperCase()).filter(Boolean)
}

function getRecentArray(
  record: Record<string, unknown> | null,
  key: string
): unknown[] {
  const filings = asRecord(record?.filings)
  const recent = asRecord(filings?.recent)
  const values = recent?.[key]
  return Array.isArray(values) ? (values as unknown[]) : []
}

function passesDateRange(
  filingDate: string,
  from: string | undefined,
  to: string | undefined
): boolean {
  if (from && filingDate < from) {
    return false
  }

  if (to && filingDate > to) {
    return false
  }

  return true
}

function summarizeFilings(params: {
  data: unknown
  cik: string
  forms: readonly string[]
  from?: string
  to?: string
  limit: number
}): SecFilingRecord[] {
  const record = asRecord(params.data)
  const forms = getRecentArray(record, "form")
  const filingDates = getRecentArray(record, "filingDate")
  const reportDates = getRecentArray(record, "reportDate")
  const accessionNumbers = getRecentArray(record, "accessionNumber")
  const primaryDocuments = getRecentArray(record, "primaryDocument")
  const primaryDocDescriptions = getRecentArray(record, "primaryDocDescription")
  const acceptedForms = new Set(params.forms.map((form) => form.toUpperCase()))
  const results: SecFilingRecord[] = []

  for (let index = 0; index < forms.length; index += 1) {
    const form = toOptionalString(forms[index])?.toUpperCase()
    const filingDate = toOptionalString(filingDates[index])
    const accessionNumber = toOptionalString(accessionNumbers[index])
    const primaryDocument = toOptionalString(primaryDocuments[index])

    if (
      !form ||
      !acceptedForms.has(form) ||
      !filingDate ||
      !passesDateRange(filingDate, params.from, params.to) ||
      !accessionNumber ||
      !primaryDocument
    ) {
      continue
    }

    results.push({
      form,
      filingDate,
      accessionNumber,
      primaryDocument,
      ...(toOptionalString(reportDates[index])
        ? { reportDate: toOptionalString(reportDates[index]) }
        : {}),
      ...(toOptionalString(primaryDocDescriptions[index])
        ? {
            primaryDocDescription: toOptionalString(
              primaryDocDescriptions[index]
            ),
          }
        : {}),
      url: buildSecFilingUrl({
        cik: params.cik,
        accessionNumber,
        primaryDocument,
      }),
    })

    if (results.length >= params.limit) {
      break
    }
  }

  return results
}

function findFilingByAccession(params: {
  data: unknown
  cik: string
  accessionNumber: string
}): SecFilingRecord | null {
  const targetAccession = normalizeAccessionForCompare(params.accessionNumber)
  const record = asRecord(params.data)
  const forms = getRecentArray(record, "form")
  const filingDates = getRecentArray(record, "filingDate")
  const reportDates = getRecentArray(record, "reportDate")
  const accessionNumbers = getRecentArray(record, "accessionNumber")
  const primaryDocuments = getRecentArray(record, "primaryDocument")
  const primaryDocDescriptions = getRecentArray(record, "primaryDocDescription")

  for (let index = 0; index < accessionNumbers.length; index += 1) {
    const accessionNumber = toOptionalString(accessionNumbers[index])
    if (
      !accessionNumber ||
      normalizeAccessionForCompare(accessionNumber) !== targetAccession
    ) {
      continue
    }

    const form = toOptionalString(forms[index])?.toUpperCase()
    const filingDate = toOptionalString(filingDates[index])
    const primaryDocument = toOptionalString(primaryDocuments[index])
    if (!form || !filingDate || !primaryDocument) {
      return null
    }

    return {
      form,
      filingDate,
      accessionNumber,
      primaryDocument,
      ...(toOptionalString(reportDates[index])
        ? { reportDate: toOptionalString(reportDates[index]) }
        : {}),
      ...(toOptionalString(primaryDocDescriptions[index])
        ? {
            primaryDocDescription: toOptionalString(
              primaryDocDescriptions[index]
            ),
          }
        : {}),
      url: buildSecFilingUrl({
        cik: params.cik,
        accessionNumber,
        primaryDocument,
      }),
    }
  }

  return null
}

async function fetchSubmissions(config: {
  cik: string
  fetchImpl: typeof fetch
  secUserAgent?: string
}) {
  const url = buildSecSubmissionsUrl(config.cik)
  const response = await fetchJsonWithRetry({
    url,
    provider: "sec",
    headers: {
      Accept: "application/json",
      "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
    },
    fetchImpl: config.fetchImpl,
  })

  if (!response.ok) {
    throw Object.assign(new Error(response.message), {
      code: response.code,
      retryable: response.retryable,
      attempts: response.attempts,
    })
  }

  return {
    data: response.data,
    url,
    attempts: response.attempts,
  }
}

async function resolveFilingDocument(config: {
  input: SecFilingsToolInput
  fetchImpl: typeof fetch
  secUserAgent?: string
}): Promise<ResolvedFilingDocument> {
  if (config.input.url) {
    if (!parseSecArchiveUrl(config.input.url)) {
      throw Object.assign(
        new Error(
          "document_fetch requires an SEC EDGAR archive document URL under https://www.sec.gov/Archives/edgar/data/."
        ),
        {
          code: "INVALID_INPUT",
          retryable: false,
        }
      )
    }

    return {
      url: config.input.url,
      attempts: 0,
      sources: [
        createSecSource(["document"], config.input.url, "SEC filing document"),
      ],
    }
  }

  const company = await resolveSecCompany(config)
  if (config.input.accessionNumber && config.input.primaryDocument) {
    const accessionNumber = normalizeAccessionNumber(
      config.input.accessionNumber
    )
    const url = buildSecFilingUrl({
      cik: company.cik,
      accessionNumber,
      primaryDocument: config.input.primaryDocument,
    })
    return {
      url,
      attempts: company.attempts,
      sources: [
        ...(company.source ? [company.source] : []),
        createSecSource(["filing"], url, "SEC filing document"),
      ],
    }
  }

  const submissions = await fetchSubmissions({
    cik: company.cik,
    fetchImpl: config.fetchImpl,
    secUserAgent: config.secUserAgent,
  })

  if (config.input.accessionNumber) {
    const filing = findFilingByAccession({
      data: submissions.data,
      cik: company.cik,
      accessionNumber: config.input.accessionNumber,
    })
    if (!filing) {
      throw Object.assign(
        new Error(
          `No SEC filing found for accession ${normalizeAccessionNumber(config.input.accessionNumber)}.`
        ),
        {
          code: "SEC_FILING_NOT_FOUND",
          retryable: false,
          attempts: company.attempts + submissions.attempts,
        }
      )
    }

    return {
      url: filing.url,
      filing,
      attempts: company.attempts + submissions.attempts,
      sources: [
        ...(company.source ? [company.source] : []),
        createSecSource(
          ["submissions"],
          submissions.url.toString(),
          "SEC company submissions"
        ),
        createSecSource(["filing"], filing.url, `SEC ${filing.form} filing`),
      ],
    }
  }

  const filings = summarizeFilings({
    data: submissions.data,
    cik: company.cik,
    forms: normalizeForms(config.input),
    from: config.input.from,
    to: config.input.to,
    limit: 1,
  })
  const filing = filings[0]
  if (!filing) {
    throw Object.assign(new Error("No matching SEC filing found."), {
      code: "SEC_FILING_NOT_FOUND",
      retryable: false,
      attempts: company.attempts + submissions.attempts,
    })
  }

  return {
    url: filing.url,
    filing,
    attempts: company.attempts + submissions.attempts,
    sources: [
      ...(company.source ? [company.source] : []),
      createSecSource(
        ["submissions"],
        submissions.url.toString(),
        "SEC company submissions"
      ),
      createSecSource(["filing"], filing.url, `SEC ${filing.form} filing`),
    ],
  }
}

async function fetchSecDocument(config: {
  input: SecFilingsToolInput
  fetchImpl: typeof fetch
  secUserAgent?: string
}): Promise<FetchedFilingDocument> {
  const resolved = await resolveFilingDocument(config)
  const url = new URL(resolved.url)
  const response = await fetchTextWithRetry({
    url,
    provider: "sec",
    headers: {
      Accept: "text/html,text/plain,application/xhtml+xml",
      "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
    },
    fetchImpl: config.fetchImpl,
  })

  if (!response.ok) {
    const parsedUrl = config.input.url
      ? parseSecArchiveUrl(config.input.url)
      : null
    const shouldResolveByAccession =
      response.code === "HTTP_404" &&
      (parsedUrl ??
        (config.input.accessionNumber && config.input.primaryDocument
          ? {
              accessionNumber: config.input.accessionNumber,
              cik: config.input.cik,
            }
          : null))
    if (shouldResolveByAccession) {
      const fallbackResolved = await resolveFilingDocument({
        input: {
          ...config.input,
          ...(parsedUrl
            ? {
                accessionNumber: parsedUrl.accessionNumber,
                cik: parsedUrl.cik,
              }
            : {}),
          primaryDocument: undefined,
          url: undefined,
        },
        fetchImpl: config.fetchImpl,
        secUserAgent: config.secUserAgent,
      })

      if (fallbackResolved.url !== resolved.url) {
        const fallbackResponse = await fetchTextWithRetry({
          url: new URL(fallbackResolved.url),
          provider: "sec",
          headers: {
            Accept: "text/html,text/plain,application/xhtml+xml",
            "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
          },
          fetchImpl: config.fetchImpl,
        })

        if (fallbackResponse.ok) {
          return {
            ...fallbackResolved,
            rawText: fallbackResponse.data,
            attempts:
              resolved.attempts +
              response.attempts +
              fallbackResolved.attempts +
              fallbackResponse.attempts,
          }
        }
      }
    }

    throw Object.assign(new Error(response.message), {
      code: response.code,
      retryable: response.retryable,
      attempts: resolved.attempts + response.attempts,
    })
  }

  return {
    ...resolved,
    rawText: response.data,
    attempts: resolved.attempts + response.attempts,
  }
}

function normalizeQueryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
    )
  )
}

function scoreText(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase()
  return terms.reduce((score, term) => {
    const matches = lower.match(
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")
    )
    return score + (matches?.length ?? 0)
  }, 0)
}

function scoreQueryAgainstText(query: string, text: string): number {
  const terms = normalizeQueryTerms(query)
  const lower = text.toLowerCase().replace(/\s+/g, " ")
  let score = scoreText(text, terms)

  for (let size = 2; size <= Math.min(5, terms.length); size += 1) {
    for (let index = 0; index <= terms.length - size; index += 1) {
      const phrase = terms.slice(index, index + size).join(" ")
      if (lower.includes(phrase)) {
        score += size * size
      }
    }
  }

  const queryTermSet = new Set(terms)
  const wantsRepurchaseTable =
    (queryTermSet.has("issuer") && queryTermSet.has("purchases")) ||
    (queryTermSet.has("shares") && queryTermSet.has("purchased")) ||
    queryTermSet.has("repurchases")
  if (wantsRepurchaseTable) {
    if (
      lower.includes("purchases of equity securities") ||
      lower.includes("company purchases of equity securities") ||
      lower.includes("stock repurchases during")
    ) {
      score += 50
    }

    if (
      lower.includes("total number of shares purchased") ||
      lower.includes("average price paid per share")
    ) {
      score += 40
    }

    if (lower.includes("earnings per share")) {
      score -= 20
    }
  }

  return score
}

function splitIntoChunks(text: string): string[] {
  return text
    .split(/\n{2,}/g)
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length >= 24)
}

function retrieveSnippets(params: {
  text: string
  query: string
  limit: number
}): { text: string; score: number }[] {
  const terms = normalizeQueryTerms(params.query)
  const chunks = splitIntoChunks(params.text)
  return chunks
    .map((chunk) => ({
      text:
        chunk.length > 2_500 ? `${chunk.slice(0, 2_500).trimEnd()}...` : chunk,
      score: terms.length > 0 ? scoreText(chunk, terms) : 1,
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, params.limit)
}

function buildDocumentSnippetFallback(params: {
  document: FetchedFilingDocument
  input: SecFilingsToolInput
  item: string
  query: string
  startedAt: number
  text: string
}): SecFilingsToolResultPayload {
  const snippets = retrieveSnippets({
    text: params.text,
    query: params.query,
    limit: Math.min(
      MAX_SNIPPET_LIMIT,
      params.input.limit ?? DEFAULT_SNIPPET_LIMIT
    ),
  })

  return {
    output: {
      operation: params.input.operation,
      provider: "sec",
      data: {
        url: params.document.url,
        item: params.item,
        query: params.query,
        snippets,
        fallback: "document_snippets",
        text: snippets.map((snippet) => snippet.text).join("\n\n"),
        truncated: false,
      },
      sources: params.document.sources,
      durationMs: Date.now() - params.startedAt,
      attempts: params.document.attempts,
    },
  }
}

function normalizeItemLabel(value: string): string {
  return value
    .trim()
    .replace(/^item\s*/i, "")
    .replace(/[.:]+$/g, "")
    .trim()
    .toUpperCase()
}

function normalizeHeadingSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function sliceSectionUntilNextItemHeading(text: string, startIndex: number) {
  const afterStart = text.slice(startIndex)
  const nextHeadingPattern = /\n\s*item\s+[0-9]{1,2}[A-Z]?\b[^\n]{0,160}/gi
  let nextHeading = nextHeadingPattern.exec(afterStart)
  while (nextHeading && nextHeading.index < 20) {
    nextHeading = nextHeadingPattern.exec(afterStart)
  }

  return nextHeading ? afterStart.slice(0, nextHeading.index) : afterStart
}

function extractItemSection(params: {
  text: string
  item: string
  maxChars: number
}): { text: string; truncated: boolean; matchedHeading?: string } | null {
  const escapedItem = params.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const headingPattern = new RegExp(
    `(^|\\n)\\s*(item\\s+${escapedItem}\\b[^\\n]{0,160})`,
    "gi"
  )
  const candidates: {
    matchedHeading?: string
    score: number
    text: string
    truncated: boolean
  }[] = []
  let match = headingPattern.exec(params.text)
  while (match) {
    const startIndex = match.index + (match[1]?.length ?? 0)
    const section = sliceSectionUntilNextItemHeading(params.text, startIndex)
    const sectionText = section.trim()
    if (sectionText) {
      const truncated = truncateText(sectionText, params.maxChars)
      candidates.push({
        ...truncated,
        matchedHeading: match[2]?.trim(),
        score:
          Math.min(sectionText.length, 5_000) -
          (/\btable of contents\b/i.test(sectionText.slice(0, 500))
            ? 1_000
            : 0),
      })
    }
    match = headingPattern.exec(params.text)
  }

  return candidates.sort((left, right) => right.score - left.score)[0] ?? null
}

function extractNamedHeadingSection(params: {
  text: string
  heading: string
  maxChars: number
}): { text: string; truncated: boolean; matchedHeading?: string } | null {
  const target = normalizeHeadingSearchText(params.heading)
  if (target.length < 4) {
    return null
  }

  for (const match of params.text.matchAll(/^([^\n]{1,220})$/gm)) {
    const matchedHeading = match[1]?.trim()
    if (!matchedHeading) {
      continue
    }

    const normalizedHeading = normalizeHeadingSearchText(matchedHeading)
    if (!normalizedHeading.includes(target)) {
      continue
    }

    const startIndex = match.index
    const section = sliceSectionUntilNextItemHeading(params.text, startIndex)
    const truncated = truncateText(section.trim(), params.maxChars)
    return {
      ...truncated,
      matchedHeading,
    }
  }

  return null
}

function extractSection(params: {
  text: string
  item: string
  maxChars: number
}): { text: string; truncated: boolean; matchedHeading?: string } | null {
  const item = normalizeItemLabel(params.item)
  if (!item) {
    return null
  }

  return (
    extractItemSection({
      text: params.text,
      item,
      maxChars: params.maxChars,
    }) ??
    extractNamedHeadingSection({
      text: params.text,
      heading: params.item,
      maxChars: params.maxChars,
    })
  )
}

function extractTableContext(html: string, tableStartIndex: number): string {
  const beforeTable = html.slice(
    Math.max(0, tableStartIndex - 2_000),
    tableStartIndex
  )
  const context = stripHtmlToText(beforeTable)
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n")

  return context.length > 1_500
    ? context.slice(context.length - 1_500).trim()
    : context
}

function parseHtmlTables(html: string): ParsedHtmlTable[] {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(
    (match, index) => {
      const tableHtml = match[0]
      const context = extractTableContext(html, match.index)
      const rows = [...tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
        .map((rowMatch) =>
          [...rowMatch[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map((cellMatch) => stripHtmlToText(cellMatch[1] ?? ""))
            .filter((cell) => cell.length > 0)
        )
        .filter((row) => row.length > 0)
      const text = rows.map((row) => row.join(" | ")).join("\n")
      return {
        ...(context ? { context } : {}),
        index,
        rows,
        text,
      }
    }
  )
}

async function runCompanySearch(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const query = (
    toOptionalString(input.query) ??
    toOptionalString(input.symbol) ??
    toOptionalString(input.cik)
  )?.toLowerCase()
  if (!query) {
    throw Object.assign(
      new Error("company_search requires `query`, `symbol`, or `cik`."),
      {
        code: "INVALID_INPUT",
        retryable: false,
      }
    )
  }

  const limit = normalizeLimit(input)
  const { rows, url, attempts } = await fetchSecTickerRows(config)
  const data = rows
    .filter(
      (row) =>
        row.cik.includes(query) ||
        row.ticker.toLowerCase().includes(query) ||
        row.title.toLowerCase().includes(query)
    )
    .slice(0, limit)

  const source = createSecSource(
    ["company_tickers"],
    url.toString(),
    "SEC company tickers"
  )
  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data,
      sources: [source],
      durationMs: Date.now() - startedAt,
      attempts,
    },
  }
}

async function runFilingSearch(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const company = await resolveSecCompany({ input, ...config })
  const submissions = await fetchSubmissions({
    cik: company.cik,
    ...config,
  })
  const filings = summarizeFilings({
    data: submissions.data,
    cik: company.cik,
    forms: normalizeForms(input),
    from: input.from,
    to: input.to,
    limit: normalizeLimit(input),
  })

  const sources = [
    ...(company.source ? [company.source] : []),
    createSecSource(
      ["submissions"],
      submissions.url.toString(),
      "SEC company submissions"
    ),
    ...filings.map((filing) =>
      createSecSource(["filing"], filing.url, `SEC ${filing.form} filing`)
    ),
  ]

  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data: {
        cik: company.cik,
        ...(company.ticker ? { ticker: company.ticker } : {}),
        ...(company.title ? { title: company.title } : {}),
        filings,
      },
      sources,
      durationMs: Date.now() - startedAt,
      attempts: company.attempts + submissions.attempts,
    },
  }
}

async function runDocumentFetch(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const document = await fetchSecDocument({ input, ...config })
  const text = stripHtmlToText(document.rawText)
  const truncated = truncateText(text, normalizeMaxChars(input))

  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data: {
        url: document.url,
        ...(document.filing ? { filing: document.filing } : {}),
        text: truncated.text,
        truncated: truncated.truncated,
      },
      sources: document.sources,
      durationMs: Date.now() - startedAt,
      attempts: document.attempts,
    },
  }
}

async function runSectionExtract(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const item = requireField(input, "item")
  const document = await fetchSecDocument({ input, ...config })
  const text = stripHtmlToText(document.rawText)
  const section = extractSection({
    text,
    item,
    maxChars: normalizeMaxChars(input),
  })
  if (!section) {
    if (input.query) {
      return buildDocumentSnippetFallback({
        document,
        input,
        item,
        query: input.query,
        startedAt,
        text,
      })
    }

    throw Object.assign(
      new Error(`Unable to find SEC filing section ${item}.`),
      {
        code: "SEC_SECTION_NOT_FOUND",
        retryable: false,
        attempts: document.attempts,
      }
    )
  }

  const snippets = input.query
    ? retrieveSnippets({
        text: section.text,
        query: input.query,
        limit: input.limit ?? DEFAULT_SNIPPET_LIMIT,
      })
    : []
  if (input.query && snippets.length === 0) {
    return buildDocumentSnippetFallback({
      document,
      input,
      item,
      query: input.query,
      startedAt,
      text,
    })
  }

  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data: {
        url: document.url,
        item,
        matchedHeading: section.matchedHeading,
        text: section.text,
        truncated: section.truncated,
        ...(input.query ? { query: input.query, snippets } : {}),
      },
      sources: document.sources,
      durationMs: Date.now() - startedAt,
      attempts: document.attempts,
    },
  }
}

async function runTableExtract(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const document = await fetchSecDocument({ input, ...config })
  const query = input.query ?? input.item
  const limit = normalizeLimit(input, 8)
  const tables = parseHtmlTables(document.rawText)
    .map((table) => ({
      ...(table.context ? { context: table.context } : {}),
      index: table.index,
      rows: table.rows,
      text: table.text,
      score: query
        ? scoreQueryAgainstText(query, `${table.context ?? ""}\n${table.text}`)
        : 1,
    }))
    .filter((table) => table.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)

  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data: {
        url: document.url,
        ...(query ? { query } : {}),
        tables,
      },
      sources: document.sources,
      durationMs: Date.now() - startedAt,
      attempts: document.attempts,
    },
  }
}

async function runRetrieveInformation(
  input: SecFilingsToolInput,
  config: Required<Pick<SecFilingsToolConfig, "fetchImpl">> &
    Pick<SecFilingsToolConfig, "secUserAgent">,
  startedAt: number
): Promise<SecFilingsToolResultPayload> {
  const query = requireField(input, "query")
  const document = await fetchSecDocument({ input, ...config })
  const text = stripHtmlToText(document.rawText)
  const snippets = retrieveSnippets({
    text,
    query,
    limit: Math.min(MAX_SNIPPET_LIMIT, input.limit ?? DEFAULT_SNIPPET_LIMIT),
  })

  return {
    output: {
      operation: input.operation,
      provider: "sec",
      data: {
        url: document.url,
        query,
        snippets,
      },
      sources: document.sources,
      durationMs: Date.now() - startedAt,
      attempts: document.attempts,
    },
  }
}

function getErrorPayload(params: {
  error: unknown
  input: SecFilingsToolInput
  startedAt: number
}): SecFilingsToolErrorPayload {
  const record = asRecord(params.error)
  const message =
    toOptionalString(record?.message) ??
    (params.error instanceof Error ? params.error.message.trim() : "")
  const code = toOptionalString(record?.code) ?? "SEC_FILINGS_FAILED"
  const attempts =
    typeof record?.attempts === "number" && Number.isFinite(record.attempts)
      ? record.attempts
      : 1
  const retryable =
    typeof record?.retryable === "boolean"
      ? record.retryable
      : classifyFinanceDataRetry({ code })

  return {
    message:
      message && message.length > 0 ? message : "SEC filings request failed.",
    code,
    operation: params.input.operation,
    provider: "sec",
    retryable,
    attempts,
    durationMs: Date.now() - params.startedAt,
  }
}

export async function runSecFilingsOperation(
  input: SecFilingsToolInput,
  config: SecFilingsToolConfig = {}
): Promise<SecFilingsToolResultPayload> {
  const startedAt = Date.now()
  const fetchImpl = config.fetchImpl ?? fetch
  const runtimeConfig = {
    fetchImpl,
    secUserAgent: config.secUserAgent,
  }

  try {
    if (input.operation === "company_search") {
      return await runCompanySearch(input, runtimeConfig, startedAt)
    }

    if (input.operation === "filing_search") {
      return await runFilingSearch(input, runtimeConfig, startedAt)
    }

    if (input.operation === "document_fetch") {
      return await runDocumentFetch(input, runtimeConfig, startedAt)
    }

    if (input.operation === "section_extract") {
      return await runSectionExtract(input, runtimeConfig, startedAt)
    }

    if (input.operation === "table_extract") {
      return await runTableExtract(input, runtimeConfig, startedAt)
    }

    return await runRetrieveInformation(input, runtimeConfig, startedAt)
  } catch (error) {
    return {
      error: getErrorPayload({
        error,
        input,
        startedAt,
      }),
    }
  }
}

function parseToolResultPayload(
  value: unknown
): SecFilingsToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  const output = asRecord(normalized.output)
  const error = asRecord(normalized.error)
  return {
    ...(output ? { output: output as unknown as SecFilingsToolOutput } : {}),
    ...(error ? { error: error as unknown as SecFilingsToolErrorPayload } : {}),
  }
}

function toSourcesFromOutput(output: SecFilingsToolOutput): MessageSource[] {
  return output.sources
}

function getToolLabel(input: unknown): string {
  const operation = toOptionalString(asRecord(input)?.operation)
  if (operation === "company_search") {
    return "Searching SEC companies"
  }

  if (operation === "filing_search") {
    return "Searching SEC filings"
  }

  if (operation === "document_fetch") {
    return "Reading SEC filing"
  }

  if (operation === "section_extract") {
    return "Extracting SEC filing section"
  }

  if (operation === "table_extract") {
    return "Extracting SEC filing tables"
  }

  if (operation === "retrieve_information") {
    return "Retrieving SEC filing evidence"
  }

  return SEC_FILINGS_LABEL
}

export function createAiSdkSecFilingsTools(config: SecFilingsToolConfig = {}) {
  return {
    sec_filings: tool({
      description:
        "Search and read SEC/EDGAR company filings. Use for public-company filing research, 10-K/10-Q/8-K retrieval, section extraction, filing table extraction, and targeted retrieval over SEC filing text. If a filing_search result gives an accessionNumber, pass that accessionNumber to document_fetch, section_extract, table_extract, or retrieve_information to target the same filing; primaryDocument is optional because this tool can resolve it. Prefer this over general web search for filing-specific facts.",
      inputSchema: secFilingsInputSchema,
      execute: async (input) =>
        runSecFilingsOperation(input, {
          fetchImpl: config.fetchImpl,
          secUserAgent: config.secUserAgent ?? process.env.SEC_API_USER_AGENT,
        }),
    }),
  }
}

export function isAiSdkSecFilingsToolName(
  value: unknown
): value is SecFilingsToolName {
  return value === SEC_FILINGS_TOOL_NAME
}

export function getAiSdkSecFilingsToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkSecFilingsToolCallMetadata | null {
  if (part?.toolName !== SEC_FILINGS_TOOL_NAME) {
    return null
  }

  const inputRecord = asRecord(part.input)
  const operation = toOptionalString(inputRecord?.operation)
  const directUrl = toOptionalString(inputRecord?.url)
  const parsedUrl = directUrl ? parseSecArchiveUrl(directUrl) : null
  const forms = Array.isArray(inputRecord?.forms)
    ? inputRecord.forms.map(toOptionalString).filter(Boolean).join(",")
    : undefined
  const query = [
    toOptionalString(inputRecord?.query),
    toOptionalString(inputRecord?.item),
    toOptionalString(inputRecord?.accessionNumber) ??
      parsedUrl?.accessionNumber,
    toOptionalString(inputRecord?.primaryDocument),
    toOptionalString(inputRecord?.symbol),
    toOptionalString(inputRecord?.cik),
    forms,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ")

  return {
    callId: part.toolCallId,
    toolName: SEC_FILINGS_TOOL_NAME,
    label: getToolLabel(part.input),
    ...(query ? { query } : {}),
    ...(operation ? { operation } : {}),
    provider: "sec",
  }
}

export function getAiSdkSecFilingsToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkSecFilingsToolResultMetadata | null {
  if (part?.toolName !== SEC_FILINGS_TOOL_NAME) {
    return null
  }

  const payload = parseToolResultPayload(part.output)
  if (!payload) {
    return {
      callId: part.toolCallId,
      toolName: SEC_FILINGS_TOOL_NAME,
      status: "error",
      sources: [],
      operation: "unknown",
      provider: "sec",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName: SEC_FILINGS_TOOL_NAME,
      status: "error",
      sources: [],
      operation: payload.error.operation,
      provider: "sec",
      attempt: payload.error.attempts,
      durationMs: payload.error.durationMs,
      errorCode: payload.error.code,
      retryable: payload.error.retryable,
    }
  }

  return {
    callId: part.toolCallId,
    toolName: SEC_FILINGS_TOOL_NAME,
    status: "success",
    sources: payload.output ? toSourcesFromOutput(payload.output) : [],
    operation: payload.output?.operation,
    provider: "sec",
    attempt: payload.output?.attempts,
    durationMs: payload.output?.durationMs,
    retryable: false,
  }
}

export const __secFilingsTestInternals = {
  buildSecFilingUrl,
  deriveCikFromAccession,
  parseSecArchiveUrl,
  stripHtmlToText,
  parseHtmlTables,
  extractSection,
  retrieveSnippets,
}
