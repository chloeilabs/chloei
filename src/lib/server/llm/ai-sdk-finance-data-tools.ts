import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import { createLogger } from "@/lib/logger"
import type { MessageSource, ToolName } from "@/lib/shared"

const FINANCE_DATA_TOOL_NAME = "finance_data" as const
const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3"
const FRED_BASE_URL = "https://api.stlouisfed.org/fred"
const SEC_COMPANY_FACTS_BASE_URL = "https://data.sec.gov/api/xbrl/companyfacts"
const SEC_COMPANY_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions"
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
const STOOQ_BASE_URL = "https://stooq.com/q/l/"
const FINANCE_DATA_MAX_ATTEMPTS = 2
const FINANCE_DATA_DEFAULT_TIMEOUT_MS = 12_000

type FinanceDataToolName = Extract<ToolName, typeof FINANCE_DATA_TOOL_NAME>
type FinanceDataProvider = "auto" | "fmp" | "sec" | "fred" | "stooq"
type ResolvedFinanceDataProvider = Exclude<FinanceDataProvider, "auto">
type FinanceDataOperation =
  | "provider_status"
  | "symbol_search"
  | "quote"
  | "company_profile"
  | "historical_prices"
  | "financial_statements"
  | "sec_company_facts"
  | "fred_series"

interface FinanceDataToolConfig {
  fmpApiKey?: string
  fredApiKey?: string
  secUserAgent?: string
  fetchImpl?: typeof fetch
}

interface FinanceDataToolOutput {
  operation: FinanceDataOperation
  provider: ResolvedFinanceDataProvider | "local"
  data: unknown
  sources: MessageSource[]
  durationMs: number
  attempts: number
  requestUrl?: string
}

interface FinanceProviderStatus {
  configured: boolean
  available: boolean
  operations: FinanceDataOperation[]
  errorCode?: string
  message?: string
}

interface FinanceDataToolErrorPayload {
  message: string
  code: string
  operation: FinanceDataOperation
  provider: ResolvedFinanceDataProvider | "local"
  retryable: boolean
  attempts: number
  durationMs: number
}

interface FinanceDataToolResultPayload {
  output?: FinanceDataToolOutput
  error?: FinanceDataToolErrorPayload
}

interface SecFactEntry {
  concept: string
  label: string
  unit: string
  value: number
  fiscalYear?: number
  fiscalPeriod?: string
  form?: string
  filed?: string
  start?: string
  end?: string
  frame?: string
}

interface SecFilingSummary {
  form: string
  filingDate: string
  accessionNumber: string
  primaryDocument: string
  url: string
}

interface AiSdkFinanceDataToolCallMetadata {
  callId: string
  toolName: FinanceDataToolName
  label: string
  operation?: string
  provider?: string
  attempt?: number
}

interface AiSdkFinanceDataToolResultMetadata {
  callId: string
  toolName: FinanceDataToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

const logger = createLogger("finance-data")

const financeDataInputSchema = z.object({
  operation: z.enum([
    "provider_status",
    "symbol_search",
    "quote",
    "company_profile",
    "historical_prices",
    "financial_statements",
    "sec_company_facts",
    "fred_series",
  ]),
  provider: z.enum(["auto", "fmp", "sec", "fred", "stooq"]).default("auto"),
  query: z.string().trim().min(1).max(500).optional(),
  symbol: z.string().trim().min(1).max(40).optional(),
  cik: z.string().trim().min(1).max(20).optional(),
  seriesId: z.string().trim().min(1).max(80).optional(),
  statementType: z
    .enum(["income", "balance_sheet", "cash_flow"])
    .default("income")
    .optional(),
  period: z.enum(["annual", "quarter"]).default("annual").optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(250).optional(),
})

type FinanceDataToolInput = z.infer<typeof financeDataInputSchema>

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function getOperationLabel(operation: FinanceDataOperation): string {
  return operation
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
}

function getToolLabel(input: unknown): string {
  const operation = toOptionalString(asRecord(input)?.operation)
  return operation
    ? `Finance: ${getOperationLabel(operation as FinanceDataOperation)}`
    : "Finance data"
}

function sanitizeSourceUrl(url: URL): string {
  const clone = new URL(url.toString())
  clone.searchParams.delete("apikey")
  clone.searchParams.delete("api_key")
  return clone.toString()
}

function hashSourceId(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash.toString(36)
}

function createProviderSource(
  provider: ResolvedFinanceDataProvider,
  operation: FinanceDataOperation,
  url: URL
): MessageSource {
  const sourceUrl = sanitizeSourceUrl(url)
  const title =
    provider === "fmp"
      ? "Financial Modeling Prep"
      : provider === "stooq"
        ? "Stooq"
        : provider === "fred"
          ? "FRED"
          : operation === "sec_company_facts" ||
              operation === "financial_statements"
            ? "SEC company facts"
            : "SEC company submissions"

  return {
    id: `${FINANCE_DATA_TOOL_NAME}-${provider}-${operation}-${hashSourceId(sourceUrl)}`,
    url: sourceUrl,
    title,
  }
}

function getConfiguredSecUserAgent(value: string | undefined): string {
  const normalized = value?.trim()
  return normalized && normalized.length > 0
    ? normalized
    : "Chloei finance_data research contact@example.com"
}

function requireField(
  input: FinanceDataToolInput,
  field: keyof FinanceDataToolInput
): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${input.operation} requires \`${field}\`.`)
  }

  return value.trim()
}

function normalizeLimit(input: FinanceDataToolInput, fallback: number): number {
  return Math.max(1, Math.min(250, input.limit ?? fallback))
}

function normalizeCik(cik: string): string {
  const digits = cik.replace(/\D/g, "")
  if (!digits) {
    throw new Error("sec_company_facts requires a numeric CIK.")
  }

  return digits.padStart(10, "0")
}

function normalizeTickerSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

function normalizeProvider(value: unknown): FinanceDataProvider {
  return value === "fmp" ||
    value === "sec" ||
    value === "fred" ||
    value === "stooq"
    ? value
    : "auto"
}

function resolveProvider(
  input: FinanceDataToolInput
): ResolvedFinanceDataProvider | "local" {
  if (input.operation === "provider_status") {
    return "local"
  }

  const requestedProvider = normalizeProvider(input.provider)
  if (requestedProvider !== "auto") {
    return requestedProvider
  }

  if (input.operation === "sec_company_facts") {
    return "sec"
  }

  if (input.operation === "fred_series") {
    return "fred"
  }

  if (input.operation === "quote") {
    return "stooq"
  }

  if (input.operation === "historical_prices") {
    return "stooq"
  }

  if (input.operation === "financial_statements") {
    return "sec"
  }

  if (input.operation === "company_profile") {
    return "sec"
  }

  return "sec"
}

function resolveFmpFallbackProvider(
  input: FinanceDataToolInput
): ResolvedFinanceDataProvider | null {
  if (input.operation === "quote") {
    return "stooq"
  }

  if (input.operation === "historical_prices") {
    return "stooq"
  }

  if (
    input.operation === "company_profile" ||
    input.operation === "symbol_search" ||
    input.operation === "financial_statements"
  ) {
    return "sec"
  }

  return null
}

function waitForRetryBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 150 * attempt)
  })
}

function getStatementEndpoint(
  statementType: FinanceDataToolInput["statementType"]
): string {
  if (statementType === "balance_sheet") {
    return "balance-sheet-statement"
  }

  if (statementType === "cash_flow") {
    return "cash-flow-statement"
  }

  return "income-statement"
}

function buildFmpUrl(input: FinanceDataToolInput, apiKey: string): URL {
  const operation = input.operation
  if (operation === "symbol_search") {
    const url = new URL(`${FMP_BASE_URL}/search`)
    url.searchParams.set("query", requireField(input, "query"))
    url.searchParams.set("limit", String(normalizeLimit(input, 10)))
    url.searchParams.set("apikey", apiKey)
    return url
  }

  if (operation === "quote") {
    const url = new URL(
      `${FMP_BASE_URL}/quote/${encodeURIComponent(requireField(input, "symbol"))}`
    )
    url.searchParams.set("apikey", apiKey)
    return url
  }

  if (operation === "company_profile") {
    const url = new URL(
      `${FMP_BASE_URL}/profile/${encodeURIComponent(requireField(input, "symbol"))}`
    )
    url.searchParams.set("apikey", apiKey)
    return url
  }

  if (operation === "historical_prices") {
    const url = new URL(
      `${FMP_BASE_URL}/historical-price-full/${encodeURIComponent(requireField(input, "symbol"))}`
    )
    if (input.from) {
      url.searchParams.set("from", input.from)
    }
    if (input.to) {
      url.searchParams.set("to", input.to)
    }
    url.searchParams.set("apikey", apiKey)
    return url
  }

  if (operation === "financial_statements") {
    const endpoint = getStatementEndpoint(input.statementType)
    const url = new URL(
      `${FMP_BASE_URL}/${endpoint}/${encodeURIComponent(requireField(input, "symbol"))}`
    )
    url.searchParams.set("period", input.period ?? "annual")
    url.searchParams.set("limit", String(normalizeLimit(input, 5)))
    url.searchParams.set("apikey", apiKey)
    return url
  }

  throw new Error(`${operation} is not supported by FMP.`)
}

function buildFmpStatusUrl(apiKey: string): URL {
  const url = new URL(`${FMP_BASE_URL}/quote-short/AAPL`)
  url.searchParams.set("apikey", apiKey)
  return url
}

function normalizeStooqSymbol(symbol: string): string {
  const normalized = normalizeTickerSymbol(symbol).toLowerCase()
  if (!normalized) {
    throw new Error("quote requires `symbol`.")
  }

  return normalized.includes(".") ? normalized : `${normalized}.us`
}

function buildStooqQuoteUrl(symbol: string): URL {
  const url = new URL(STOOQ_BASE_URL)
  url.searchParams.set("s", normalizeStooqSymbol(symbol))
  url.searchParams.set("f", "sd2t2ohlcvn")
  url.searchParams.set("h", "")
  url.searchParams.set("e", "csv")
  return url
}

function toStooqDate(value: string): string {
  return value.replaceAll("-", "")
}

function buildStooqHistoricalPricesUrl(input: FinanceDataToolInput): URL {
  const url = new URL("https://stooq.com/q/d/l/")
  url.searchParams.set("s", normalizeStooqSymbol(requireField(input, "symbol")))
  url.searchParams.set("i", "d")
  if (input.from) {
    url.searchParams.set("d1", toStooqDate(input.from))
  }
  if (input.to) {
    url.searchParams.set("d2", toStooqDate(input.to))
  }
  return url
}

function buildFredUrl(input: FinanceDataToolInput, apiKey: string): URL {
  const url = new URL(`${FRED_BASE_URL}/series/observations`)
  url.searchParams.set("series_id", requireField(input, "seriesId"))
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("file_type", "json")
  url.searchParams.set("sort_order", "desc")
  url.searchParams.set("limit", String(normalizeLimit(input, 24)))
  if (input.from) {
    url.searchParams.set("observation_start", input.from)
  }
  if (input.to) {
    url.searchParams.set("observation_end", input.to)
  }
  return url
}

function buildFredStatusUrl(apiKey: string): URL {
  const url = new URL(`${FRED_BASE_URL}/series/observations`)
  url.searchParams.set("series_id", "FEDFUNDS")
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("file_type", "json")
  url.searchParams.set("sort_order", "desc")
  url.searchParams.set("limit", "1")
  return url
}

function buildSecCompanyFactsUrl(cik: string): URL {
  return new URL(`${SEC_COMPANY_FACTS_BASE_URL}/CIK${normalizeCik(cik)}.json`)
}

function buildSecUrl(input: FinanceDataToolInput): URL {
  return buildSecCompanyFactsUrl(requireField(input, "cik"))
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
  const primaryDocument = params.primaryDocument.trim()

  return `https://www.sec.gov/Archives/edgar/data/${String(cikNumber)}/${accessionDirectory}/${primaryDocument}`
}

function buildSecCompanyTickersUrl(): URL {
  return new URL(SEC_COMPANY_TICKERS_URL)
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let quoted = false

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      continue
    }

    if (char === "," && !quoted) {
      values.push(current)
      current = ""
      continue
    }

    current += char
  }

  values.push(current)
  return values
}

function toNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseStooqQuoteCsv(csv: string) {
  const lines = csv
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  const headers = lines[0] ? parseCsvLine(lines[0]) : []
  const row = lines[1] ? parseCsvLine(lines[1]) : []
  const record = Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ""])
  )
  const close = toNumber(record.Close ?? "")

  if (!record.Symbol || record.Symbol === "N/D" || close === null) {
    throw Object.assign(new Error("Stooq quote data is unavailable."), {
      code: "QUOTE_UNAVAILABLE",
      retryable: true,
    })
  }

  return {
    symbol: record.Symbol,
    date: record.Date,
    time: record.Time,
    open: toNumber(record.Open ?? ""),
    high: toNumber(record.High ?? ""),
    low: toNumber(record.Low ?? ""),
    close,
    volume: toNumber(record.Volume ?? ""),
    name: record.Name,
    delayed: true,
  }
}

function parseStooqHistoricalPricesCsv(
  csv: string,
  input: FinanceDataToolInput
) {
  const lines = csv
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  const headers = lines[0] ? parseCsvLine(lines[0]) : []
  const rows = lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line)
    const record = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""])
    )
    const close = toNumber(record.Close ?? "")
    if (!record.Date || close === null) {
      return []
    }

    return [
      {
        date: record.Date,
        open: toNumber(record.Open ?? ""),
        high: toNumber(record.High ?? ""),
        low: toNumber(record.Low ?? ""),
        close,
        volume: toNumber(record.Volume ?? ""),
      },
    ]
  })

  if (rows.length === 0) {
    throw Object.assign(new Error("Stooq historical prices are unavailable."), {
      code: "HISTORICAL_PRICES_UNAVAILABLE",
      retryable: true,
    })
  }

  const limit = normalizeLimit(input, 30)
  return {
    symbol: normalizeStooqSymbol(requireField(input, "symbol")).toUpperCase(),
    interval: "1d",
    rows: rows.slice(-limit),
    rowCount: Math.min(rows.length, limit),
    totalRowsAvailable: rows.length,
    truncated: rows.length > limit,
  }
}

export function classifyFinanceDataRetry(params: {
  status?: number
  code?: string
}): boolean {
  if (
    params.status &&
    [408, 409, 425, 429, 500, 502, 503, 504].includes(params.status)
  ) {
    return true
  }

  const code = params.code?.trim().toUpperCase()
  return Boolean(
    code &&
    [
      "ABORT_ERR",
      "ECONNRESET",
      "ETIMEDOUT",
      "FETCH_FAILED",
      "NETWORK_ERROR",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  )
}

async function fetchJsonWithRetry(params: {
  url: URL
  provider: ResolvedFinanceDataProvider
  headers?: HeadersInit
  fetchImpl: typeof fetch
  timeoutMs?: number
}) {
  let lastError: unknown

  for (let attempt = 1; attempt <= FINANCE_DATA_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Timed out", "AbortError"))
    }, params.timeoutMs ?? FINANCE_DATA_DEFAULT_TIMEOUT_MS)

    try {
      const response = await params.fetchImpl(params.url, {
        headers: params.headers,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const retryable = classifyFinanceDataRetry({ status: response.status })
        if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
          await waitForRetryBackoff(attempt)
          continue
        }

        return {
          ok: false as const,
          attempts: attempt,
          retryable,
          status: response.status,
          code: `HTTP_${String(response.status)}`,
          message: `${params.provider} returned HTTP ${String(response.status)}.`,
        }
      }

      return {
        ok: true as const,
        attempts: attempt,
        data: (await response.json()) as unknown,
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error
      const record = asRecord(error)
      const code =
        toOptionalString(record?.code) ??
        (error instanceof DOMException ? error.name : undefined)
      const retryable = classifyFinanceDataRetry({ code })
      if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
        await waitForRetryBackoff(attempt)
        continue
      }

      return {
        ok: false as const,
        attempts: attempt,
        retryable,
        code: code ?? "FETCH_FAILED",
        message:
          toOptionalString(record?.message) ??
          (error instanceof Error
            ? error.message
            : "Finance data request failed."),
      }
    }
  }

  return {
    ok: false as const,
    attempts: FINANCE_DATA_MAX_ATTEMPTS,
    retryable: false,
    code: "FETCH_FAILED",
    message:
      lastError instanceof Error
        ? lastError.message
        : "Finance data request failed.",
  }
}

async function fetchTextWithRetry(params: {
  url: URL
  provider: ResolvedFinanceDataProvider
  headers?: HeadersInit
  fetchImpl: typeof fetch
  timeoutMs?: number
}) {
  let lastError: unknown

  for (let attempt = 1; attempt <= FINANCE_DATA_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Timed out", "AbortError"))
    }, params.timeoutMs ?? FINANCE_DATA_DEFAULT_TIMEOUT_MS)

    try {
      const response = await params.fetchImpl(params.url, {
        headers: params.headers,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const retryable = classifyFinanceDataRetry({ status: response.status })
        if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
          await waitForRetryBackoff(attempt)
          continue
        }

        return {
          ok: false as const,
          attempts: attempt,
          retryable,
          status: response.status,
          code: `HTTP_${String(response.status)}`,
          message: `${params.provider} returned HTTP ${String(response.status)}.`,
        }
      }

      return {
        ok: true as const,
        attempts: attempt,
        data: await response.text(),
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error
      const record = asRecord(error)
      const code =
        toOptionalString(record?.code) ??
        (error instanceof DOMException ? error.name : undefined)
      const retryable = classifyFinanceDataRetry({ code })
      if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
        await waitForRetryBackoff(attempt)
        continue
      }

      return {
        ok: false as const,
        attempts: attempt,
        retryable,
        code: code ?? "FETCH_FAILED",
        message:
          toOptionalString(record?.message) ??
          (error instanceof Error
            ? error.message
            : "Finance data request failed."),
      }
    }
  }

  return {
    ok: false as const,
    attempts: FINANCE_DATA_MAX_ATTEMPTS,
    retryable: false,
    code: "FETCH_FAILED",
    message:
      lastError instanceof Error
        ? lastError.message
        : "Finance data request failed.",
  }
}

async function checkJsonProviderStatus(params: {
  configured: boolean
  provider: ResolvedFinanceDataProvider
  operations: FinanceDataOperation[]
  url?: URL
  headers?: HeadersInit
  fetchImpl: typeof fetch
}): Promise<FinanceProviderStatus> {
  if (!params.configured || !params.url) {
    return {
      configured: false,
      available: false,
      operations: params.operations,
      errorCode: "PROVIDER_NOT_CONFIGURED",
      message: `${params.provider.toUpperCase()} is not configured.`,
    }
  }

  const result = await fetchJsonWithRetry({
    url: params.url,
    provider: params.provider,
    headers: params.headers,
    fetchImpl: params.fetchImpl,
    timeoutMs: 5_000,
  })

  if (result.ok) {
    return {
      configured: true,
      available: true,
      operations: params.operations,
    }
  }

  return {
    configured: true,
    available: false,
    operations: params.operations,
    errorCode: result.code,
    message: result.message,
  }
}

async function checkTextProviderStatus(params: {
  provider: ResolvedFinanceDataProvider
  operations: FinanceDataOperation[]
  url: URL
  fetchImpl: typeof fetch
  validate: (text: string) => boolean
}): Promise<FinanceProviderStatus> {
  const result = await fetchTextWithRetry({
    url: params.url,
    provider: params.provider,
    fetchImpl: params.fetchImpl,
    timeoutMs: 5_000,
  })

  if (result.ok && params.validate(result.data)) {
    return {
      configured: true,
      available: true,
      operations: params.operations,
    }
  }

  return {
    configured: true,
    available: false,
    operations: params.operations,
    errorCode: result.ok ? "PROVIDER_RESPONSE_INVALID" : result.code,
    message: result.ok
      ? `${params.provider} returned an invalid status response.`
      : result.message,
  }
}

async function getFinanceProviderStatus(
  config: FinanceDataToolConfig,
  fetchImpl: typeof fetch
): Promise<Record<ResolvedFinanceDataProvider, FinanceProviderStatus>> {
  const fmpApiKey = config.fmpApiKey?.trim()
  const fredApiKey = config.fredApiKey?.trim()

  const [fmp, fred, stooq] = await Promise.all([
    checkJsonProviderStatus({
      configured: Boolean(fmpApiKey),
      provider: "fmp",
      operations: [
        "symbol_search",
        "quote",
        "company_profile",
        "historical_prices",
        "financial_statements",
      ],
      url: fmpApiKey ? buildFmpStatusUrl(fmpApiKey) : undefined,
      fetchImpl,
    }),
    checkJsonProviderStatus({
      configured: Boolean(fredApiKey),
      provider: "fred",
      operations: ["fred_series"],
      url: fredApiKey ? buildFredStatusUrl(fredApiKey) : undefined,
      fetchImpl,
    }),
    checkTextProviderStatus({
      provider: "stooq",
      operations: ["quote"],
      url: buildStooqQuoteUrl("AAPL"),
      fetchImpl,
      validate: (text) => {
        try {
          parseStooqQuoteCsv(text)
          return true
        } catch {
          return false
        }
      },
    }),
  ])

  return {
    fmp,
    fred,
    stooq,
    sec: {
      configured: true,
      available: true,
      operations: [
        "symbol_search",
        "company_profile",
        "financial_statements",
        "sec_company_facts",
      ],
      ...(config.secUserAgent?.trim()
        ? {}
        : {
            message:
              "SEC public data is available, but SEC_API_USER_AGENT is not configured; Chloei will use its fallback user agent.",
          }),
    },
  }
}

function toSecCompanyTickerRows(value: unknown) {
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
    })
  }

  return {
    rows: toSecCompanyTickerRows(response.data),
    url,
    attempts: response.attempts,
  }
}

async function resolveSecCikFromSymbol(config: {
  symbol: string
  fetchImpl: typeof fetch
  secUserAgent?: string
}) {
  const { rows, url, attempts } = await fetchSecTickerRows(config)
  const normalizedSymbol = normalizeTickerSymbol(config.symbol)
  const match = rows.find(
    (row) => row.ticker.toUpperCase() === normalizedSymbol
  )
  if (!match) {
    throw Object.assign(
      new Error(`Unable to resolve SEC CIK for symbol ${normalizedSymbol}.`),
      {
        code: "SEC_CIK_NOT_FOUND",
        retryable: false,
      }
    )
  }

  return {
    ...match,
    sourceUrl: url,
    attempts,
  }
}

function summarizeLatestSecFiling(params: {
  data: unknown
  cik: string
  forms: readonly string[]
}): SecFilingSummary | undefined {
  const record = asRecord(params.data)
  const filings = asRecord(record?.filings)
  const recent = asRecord(filings?.recent)
  const forms = Array.isArray(recent?.form) ? recent.form : []
  const filingDates = Array.isArray(recent?.filingDate) ? recent.filingDate : []
  const accessionNumbers = Array.isArray(recent?.accessionNumber)
    ? recent.accessionNumber
    : []
  const primaryDocuments = Array.isArray(recent?.primaryDocument)
    ? recent.primaryDocument
    : []
  const acceptedForms = new Set(params.forms.map((form) => form.toUpperCase()))

  for (let index = 0; index < forms.length; index += 1) {
    const form = toOptionalString(forms[index])?.toUpperCase()
    const filingDate = toOptionalString(filingDates[index])
    const accessionNumber = toOptionalString(accessionNumbers[index])
    const primaryDocument = toOptionalString(primaryDocuments[index])

    if (
      !form ||
      !acceptedForms.has(form) ||
      !filingDate ||
      !accessionNumber ||
      !primaryDocument
    ) {
      continue
    }

    return {
      form,
      filingDate,
      accessionNumber,
      primaryDocument,
      url: buildSecFilingUrl({
        cik: params.cik,
        accessionNumber,
        primaryDocument,
      }),
    }
  }

  return undefined
}

async function fetchLatestSecFilingSummary(config: {
  cik: string
  period: FinanceDataToolInput["period"]
  fetchImpl: typeof fetch
  secUserAgent?: string
}): Promise<{
  filing?: SecFilingSummary
  source?: MessageSource
  attempts: number
}> {
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
    return { attempts: response.attempts }
  }

  const filing = summarizeLatestSecFiling({
    data: response.data,
    cik: config.cik,
    forms:
      config.period === "quarter"
        ? ["10-Q", "10-Q/A"]
        : ["10-K", "10-K/A", "20-F", "40-F"],
  })

  return {
    attempts: response.attempts,
    filing,
    ...(filing
      ? {
          source: {
            id: `${FINANCE_DATA_TOOL_NAME}-sec-filing-${hashSourceId(filing.url)}`,
            url: filing.url,
            title: `SEC ${filing.form} filing`,
          },
        }
      : {}),
  }
}

function summarizeSecSubmission(data: unknown, fallback?: { ticker?: string }) {
  const record = asRecord(data)
  const tickers = Array.isArray(record?.tickers)
    ? record.tickers.filter(
        (value): value is string => typeof value === "string"
      )
    : fallback?.ticker
      ? [fallback.ticker]
      : []
  const exchanges = Array.isArray(record?.exchanges)
    ? record.exchanges.filter(
        (value): value is string => typeof value === "string"
      )
    : []
  const addresses = asRecord(record?.addresses)
  const businessAddress = asRecord(addresses?.business)

  return {
    cik: toOptionalString(record?.cik),
    name: toOptionalString(record?.name),
    tickers,
    exchanges,
    entityType: toOptionalString(record?.entityType),
    sic: toOptionalString(record?.sic),
    sicDescription: toOptionalString(record?.sicDescription),
    ownerOrg: toOptionalString(record?.ownerOrg),
    category: toOptionalString(record?.category),
    fiscalYearEnd: toOptionalString(record?.fiscalYearEnd),
    stateOfIncorporation: toOptionalString(record?.stateOfIncorporation),
    businessAddress: businessAddress
      ? {
          city: toOptionalString(businessAddress.city),
          stateOrCountry: toOptionalString(businessAddress.stateOrCountry),
        }
      : undefined,
  }
}

const SEC_INCOME_STATEMENT_CONCEPTS = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  costOfRevenue: [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsSold",
    "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
} as const

const SEC_BALANCE_SHEET_CONCEPTS = {
  cashAndEquivalents: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  currentAssets: ["AssetsCurrent"],
  totalAssets: ["Assets"],
  currentLiabilities: ["LiabilitiesCurrent"],
  totalLiabilities: ["Liabilities"],
  currentDebt: [
    "LongTermDebtCurrent",
    "ShortTermBorrowings",
    "ShortTermBorrowingsCurrent",
    "ShortTermDebtCurrent",
    "LongTermDebtAndFinanceLeaseObligationsCurrent",
  ],
  longTermDebt: [
    "LongTermDebtNoncurrent",
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    "LongTermDebt",
  ],
  stockholdersEquity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  liabilitiesAndEquity: ["LiabilitiesAndStockholdersEquity"],
} as const

const SEC_CASH_FLOW_CONCEPTS = {
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  capitalExpenditures: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ],
  depreciationAndAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationDepletionAndAmortizationExpense",
    "DepreciationAndAmortization",
  ],
  shareBasedCompensation: [
    "ShareBasedCompensation",
    "ShareBasedCompensationArrangementByShareBasedPaymentAwardExpense",
  ],
  dividendsPaid: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
  shareRepurchases: [
    "PaymentsForRepurchaseOfCommonStock",
    "PaymentsForRepurchaseOfEquity",
  ],
  cashPeriodChange: [
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
    "CashAndCashEquivalentsPeriodIncreaseDecrease",
  ],
} as const

const SEC_FINANCIAL_STATEMENT_CONCEPTS = [
  ...Object.values(SEC_INCOME_STATEMENT_CONCEPTS).flat(),
  ...Object.values(SEC_BALANCE_SHEET_CONCEPTS).flat(),
  ...Object.values(SEC_CASH_FLOW_CONCEPTS).flat(),
] as const

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  return value
}

function getSecFactEntries(data: unknown, concept: string): SecFactEntry[] {
  const record = asRecord(data)
  const facts = asRecord(record?.facts)
  const usGaap = asRecord(facts?.["us-gaap"])
  const fact = asRecord(usGaap?.[concept])
  const units = asRecord(fact?.units)
  const usdRows = Array.isArray(units?.USD) ? units.USD : []
  const label = toOptionalString(fact?.label) ?? concept

  return usdRows.flatMap((entry): SecFactEntry[] => {
    const row = asRecord(entry)
    const value = toOptionalNumber(row?.val)
    if (value === undefined) {
      return []
    }

    return [
      {
        concept,
        label,
        unit: "USD",
        value,
        fiscalYear: toOptionalNumber(row?.fy),
        fiscalPeriod: toOptionalString(row?.fp),
        form: toOptionalString(row?.form),
        filed: toOptionalString(row?.filed),
        start: toOptionalString(row?.start),
        end: toOptionalString(row?.end),
        frame: toOptionalString(row?.frame),
      },
    ]
  })
}

function isSecFactForPeriod(
  entry: SecFactEntry,
  period: FinanceDataToolInput["period"]
): boolean {
  const form = entry.form?.toUpperCase()
  const fiscalPeriod = entry.fiscalPeriod?.toUpperCase()

  if (period === "quarter") {
    return (
      (form === "10-Q" || form === "10-Q/A") &&
      Boolean(fiscalPeriod?.startsWith("Q"))
    )
  }

  return (
    (form === "10-K" || form === "10-K/A" || form === "20-F") &&
    fiscalPeriod === "FY"
  )
}

function getDateSortValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function sortSecFactEntries(entries: SecFactEntry[]): SecFactEntry[] {
  return [...entries].sort((a, b) => {
    const endDelta = getDateSortValue(b.end) - getDateSortValue(a.end)
    if (endDelta !== 0) {
      return endDelta
    }

    return getDateSortValue(b.filed) - getDateSortValue(a.filed)
  })
}

function findLatestSecFact(
  data: unknown,
  concepts: readonly string[],
  period: FinanceDataToolInput["period"]
): SecFactEntry | undefined {
  return sortSecFactEntries(
    concepts.flatMap((concept) =>
      getSecFactEntries(data, concept).filter((entry) =>
        isSecFactForPeriod(entry, period)
      )
    )
  )[0]
}

function findMatchingSecFact(
  data: unknown,
  concepts: readonly string[],
  period: FinanceDataToolInput["period"],
  anchor: SecFactEntry
): SecFactEntry | undefined {
  const candidates = sortSecFactEntries(
    concepts.flatMap((concept) =>
      getSecFactEntries(data, concept).filter((entry) =>
        isSecFactForPeriod(entry, period)
      )
    )
  )
  const exactMatch = candidates.find(
    (entry) =>
      entry.fiscalYear === anchor.fiscalYear &&
      entry.fiscalPeriod === anchor.fiscalPeriod &&
      entry.end === anchor.end
  )
  if (exactMatch) {
    return exactMatch
  }

  return candidates.find(
    (entry) =>
      entry.fiscalYear === anchor.fiscalYear &&
      entry.fiscalPeriod === anchor.fiscalPeriod
  )
}

function serializeSecFact(entry: SecFactEntry | undefined) {
  if (!entry) {
    return undefined
  }

  return {
    value: entry.value,
    unit: entry.unit,
    concept: entry.concept,
    label: entry.label,
  }
}

function calculateRatio(numerator: number | undefined, denominator: number) {
  if (typeof numerator !== "number" || denominator === 0) {
    return undefined
  }

  return numerator / denominator
}

function findLatestSecStatementAnchor(
  data: unknown,
  conceptGroups: readonly (readonly string[] | string[])[],
  period: FinanceDataToolInput["period"]
): SecFactEntry | undefined {
  return findLatestSecFact(data, conceptGroups.flat(), period)
}

function sumDefinedValues(values: (number | undefined)[]): number | undefined {
  const definedValues = values.filter(
    (value): value is number => typeof value === "number"
  )
  if (definedValues.length === 0) {
    return undefined
  }

  return definedValues.reduce((total, value) => total + value, 0)
}

function summarizeSecIncomeStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: FinanceDataToolInput["period"]
}) {
  const revenue = findLatestSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.revenue,
    params.period
  )
  if (!revenue) {
    throw Object.assign(
      new Error("SEC income statement revenue is unavailable."),
      {
        code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
        retryable: false,
      }
    )
  }

  const costOfRevenue = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.costOfRevenue,
    params.period,
    revenue
  )
  const grossProfit =
    findMatchingSecFact(
      params.data,
      SEC_INCOME_STATEMENT_CONCEPTS.grossProfit,
      params.period,
      revenue
    ) ??
    (costOfRevenue
      ? {
          ...revenue,
          concept: "ComputedGrossProfit",
          label: "Revenue less cost of revenue",
          value: revenue.value - costOfRevenue.value,
        }
      : undefined)
  const operatingIncome = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.operatingIncome,
    params.period,
    revenue
  )
  const netIncome = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.netIncome,
    params.period,
    revenue
  )

  return {
    statementType: "income",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: revenue.fiscalYear,
    fiscalPeriod: revenue.fiscalPeriod,
    form: revenue.form,
    filed: revenue.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodStart: revenue.start,
    periodEnd: revenue.end,
    reportedFacts: {
      revenue: serializeSecFact(revenue),
      costOfRevenue: serializeSecFact(costOfRevenue),
      grossProfit: serializeSecFact(grossProfit),
      operatingIncome: serializeSecFact(operatingIncome),
      netIncome: serializeSecFact(netIncome),
    },
    computedValues: {
      grossMargin: calculateRatio(grossProfit?.value, revenue.value),
      operatingMargin: calculateRatio(operatingIncome?.value, revenue.value),
      netMargin: calculateRatio(netIncome?.value, revenue.value),
    },
  }
}

function summarizeSecBalanceSheet(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: FinanceDataToolInput["period"]
}) {
  const anchor = findLatestSecStatementAnchor(
    params.data,
    [
      SEC_BALANCE_SHEET_CONCEPTS.totalAssets,
      SEC_BALANCE_SHEET_CONCEPTS.totalLiabilities,
      SEC_BALANCE_SHEET_CONCEPTS.stockholdersEquity,
    ],
    params.period
  )
  if (!anchor) {
    throw Object.assign(new Error("SEC balance sheet facts are unavailable."), {
      code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
      retryable: false,
    })
  }

  const cashAndEquivalents = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.cashAndEquivalents,
    params.period,
    anchor
  )
  const currentAssets = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentAssets,
    params.period,
    anchor
  )
  const totalAssets = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.totalAssets,
    params.period,
    anchor
  )
  const currentLiabilities = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentLiabilities,
    params.period,
    anchor
  )
  const totalLiabilities = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.totalLiabilities,
    params.period,
    anchor
  )
  const currentDebt = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentDebt,
    params.period,
    anchor
  )
  const longTermDebt = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.longTermDebt,
    params.period,
    anchor
  )
  const stockholdersEquity = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.stockholdersEquity,
    params.period,
    anchor
  )
  const liabilitiesAndEquity = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.liabilitiesAndEquity,
    params.period,
    anchor
  )
  const totalDebt = sumDefinedValues([currentDebt?.value, longTermDebt?.value])

  return {
    statementType: "balance_sheet",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: anchor.fiscalYear,
    fiscalPeriod: anchor.fiscalPeriod,
    form: anchor.form,
    filed: anchor.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodEnd: anchor.end,
    reportedFacts: {
      cashAndEquivalents: serializeSecFact(cashAndEquivalents),
      currentAssets: serializeSecFact(currentAssets),
      totalAssets: serializeSecFact(totalAssets),
      currentLiabilities: serializeSecFact(currentLiabilities),
      totalLiabilities: serializeSecFact(totalLiabilities),
      currentDebt: serializeSecFact(currentDebt),
      longTermDebt: serializeSecFact(longTermDebt),
      stockholdersEquity: serializeSecFact(stockholdersEquity),
      liabilitiesAndEquity: serializeSecFact(liabilitiesAndEquity),
    },
    computedValues: {
      totalDebt,
      netDebt:
        typeof totalDebt === "number" &&
        typeof cashAndEquivalents?.value === "number"
          ? totalDebt - cashAndEquivalents.value
          : undefined,
      workingCapital:
        typeof currentAssets?.value === "number" &&
        typeof currentLiabilities?.value === "number"
          ? currentAssets.value - currentLiabilities.value
          : undefined,
      liabilitiesToAssets: totalAssets
        ? calculateRatio(totalLiabilities?.value, totalAssets.value)
        : undefined,
      equityRatio: totalAssets
        ? calculateRatio(stockholdersEquity?.value, totalAssets.value)
        : undefined,
      debtToAssets:
        typeof totalDebt === "number" && totalAssets
          ? calculateRatio(totalDebt, totalAssets.value)
          : undefined,
    },
  }
}

function summarizeSecCashFlowStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: FinanceDataToolInput["period"]
}) {
  const operatingCashFlow = findLatestSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.operatingCashFlow,
    params.period
  )
  if (!operatingCashFlow) {
    throw Object.assign(
      new Error("SEC cash flow statement facts are unavailable."),
      {
        code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
        retryable: false,
      }
    )
  }

  const capitalExpenditures = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.capitalExpenditures,
    params.period,
    operatingCashFlow
  )
  const depreciationAndAmortization = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.depreciationAndAmortization,
    params.period,
    operatingCashFlow
  )
  const shareBasedCompensation = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.shareBasedCompensation,
    params.period,
    operatingCashFlow
  )
  const dividendsPaid = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.dividendsPaid,
    params.period,
    operatingCashFlow
  )
  const shareRepurchases = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.shareRepurchases,
    params.period,
    operatingCashFlow
  )
  const cashPeriodChange = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.cashPeriodChange,
    params.period,
    operatingCashFlow
  )
  const revenue = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.revenue,
    params.period,
    operatingCashFlow
  )
  const capexValue = capitalExpenditures?.value
  const freeCashFlow =
    typeof capexValue === "number"
      ? operatingCashFlow.value - Math.abs(capexValue)
      : undefined

  return {
    statementType: "cash_flow",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: operatingCashFlow.fiscalYear,
    fiscalPeriod: operatingCashFlow.fiscalPeriod,
    form: operatingCashFlow.form,
    filed: operatingCashFlow.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodStart: operatingCashFlow.start,
    periodEnd: operatingCashFlow.end,
    reportedFacts: {
      operatingCashFlow: serializeSecFact(operatingCashFlow),
      capitalExpenditures: serializeSecFact(capitalExpenditures),
      depreciationAndAmortization: serializeSecFact(
        depreciationAndAmortization
      ),
      shareBasedCompensation: serializeSecFact(shareBasedCompensation),
      dividendsPaid: serializeSecFact(dividendsPaid),
      shareRepurchases: serializeSecFact(shareRepurchases),
      cashPeriodChange: serializeSecFact(cashPeriodChange),
      revenue: serializeSecFact(revenue),
    },
    computedValues: {
      freeCashFlow,
      freeCashFlowMargin:
        typeof freeCashFlow === "number" && revenue
          ? calculateRatio(freeCashFlow, revenue.value)
          : undefined,
    },
  }
}

function summarizeSecFinancialStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  statementType: FinanceDataToolInput["statementType"]
  period: FinanceDataToolInput["period"]
}) {
  if (params.statementType === "balance_sheet") {
    return summarizeSecBalanceSheet(params)
  }

  if (params.statementType === "cash_flow") {
    return summarizeSecCashFlowStatement(params)
  }

  return summarizeSecIncomeStatement(params)
}

function summarizeSecCompanyFacts(params: {
  data: unknown
  cik: string
  symbol?: string
}) {
  const record = asRecord(params.data)
  const facts = asRecord(record?.facts)
  const usGaap = asRecord(facts?.["us-gaap"])
  const selectedConcepts = SEC_FINANCIAL_STATEMENT_CONCEPTS.filter((concept) =>
    Boolean(usGaap?.[concept])
  )

  let latestAnnualIncomeStatement: unknown
  let latestAnnualBalanceSheet: unknown
  let latestAnnualCashFlowStatement: unknown
  try {
    latestAnnualIncomeStatement = summarizeSecIncomeStatement({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualIncomeStatement = undefined
  }
  try {
    latestAnnualBalanceSheet = summarizeSecBalanceSheet({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualBalanceSheet = undefined
  }
  try {
    latestAnnualCashFlowStatement = summarizeSecCashFlowStatement({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualCashFlowStatement = undefined
  }

  return {
    cik: normalizeCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    entityName: toOptionalString(record?.entityName),
    taxonomyNamespaces: Object.keys(facts ?? {}).sort(),
    usGaapConceptCount: Object.keys(usGaap ?? {}).length,
    selectedConcepts,
    ...(latestAnnualIncomeStatement ? { latestAnnualIncomeStatement } : {}),
    ...(latestAnnualBalanceSheet ? { latestAnnualBalanceSheet } : {}),
    ...(latestAnnualCashFlowStatement ? { latestAnnualCashFlowStatement } : {}),
  }
}

export async function runFinanceDataOperation(
  input: FinanceDataToolInput,
  config: FinanceDataToolConfig = {}
): Promise<FinanceDataToolResultPayload> {
  const startedAt = Date.now()
  const fetchImpl = config.fetchImpl ?? fetch
  const provider = resolveProvider(input)

  if (provider === "local") {
    const status = await getFinanceProviderStatus(config, fetchImpl)
    return {
      output: {
        operation: input.operation,
        provider,
        data: status,
        sources: [],
        durationMs: Date.now() - startedAt,
        attempts: 1,
      },
    }
  }

  try {
    if (provider === "fmp") {
      const apiKey = config.fmpApiKey?.trim()
      const fallbackProvider = resolveFmpFallbackProvider(input)
      if (!apiKey) {
        if (fallbackProvider) {
          return await runFinanceDataOperation(
            { ...input, provider: fallbackProvider },
            config
          )
        }

        throw Object.assign(new Error("FMP API key is not configured."), {
          code: "PROVIDER_UNAVAILABLE",
          retryable: false,
        })
      }
      const url = buildFmpUrl(input, apiKey)
      const response = await fetchJsonWithRetry({
        url,
        provider,
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        if (
          fallbackProvider &&
          (response.code === "HTTP_401" || response.code === "HTTP_403")
        ) {
          return await runFinanceDataOperation(
            { ...input, provider: fallbackProvider },
            config
          )
        }

        logger.warn("Finance data provider request failed.", {
          durationMs,
          errorCode: response.code,
          outcome: "provider_error",
          provider,
        })

        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data: response.data,
          sources: [source],
          durationMs,
          attempts: response.attempts,
          requestUrl: source.url,
        },
      }
    }

    if (provider === "fred") {
      const apiKey = config.fredApiKey?.trim()
      if (!apiKey) {
        throw Object.assign(new Error("FRED API key is not configured."), {
          code: "PROVIDER_UNAVAILABLE",
          retryable: false,
        })
      }
      const url = buildFredUrl(input, apiKey)
      const response = await fetchJsonWithRetry({
        url,
        provider,
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        logger.warn("Finance data provider request failed.", {
          durationMs,
          errorCode: response.code,
          outcome: "provider_error",
          provider,
        })

        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data: response.data,
          sources: [source],
          durationMs,
          attempts: response.attempts,
          requestUrl: source.url,
        },
      }
    }

    if (provider === "stooq") {
      if (
        input.operation !== "quote" &&
        input.operation !== "historical_prices"
      ) {
        throw Object.assign(
          new Error(`${input.operation} is not supported by Stooq.`),
          {
            code: "OPERATION_UNSUPPORTED",
            retryable: false,
          }
        )
      }

      const url =
        input.operation === "quote"
          ? buildStooqQuoteUrl(requireField(input, "symbol"))
          : buildStooqHistoricalPricesUrl(input)
      const response = await fetchTextWithRetry({
        url,
        provider,
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const data =
        input.operation === "quote"
          ? parseStooqQuoteCsv(response.data)
          : parseStooqHistoricalPricesCsv(response.data, input)
      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data,
          sources: [source],
          durationMs,
          attempts: response.attempts,
          requestUrl: source.url,
        },
      }
    }

    if (input.operation === "symbol_search") {
      const query = requireField(input, "query").toLowerCase()
      const { rows, url, attempts } = await fetchSecTickerRows({
        fetchImpl,
        secUserAgent: config.secUserAgent,
      })
      const limit = normalizeLimit(input, 10)
      const data = rows
        .filter(
          (row) =>
            row.ticker.toLowerCase().includes(query) ||
            row.title.toLowerCase().includes(query)
        )
        .slice(0, limit)
      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data,
          sources: [source],
          durationMs: Date.now() - startedAt,
          attempts,
          requestUrl: source.url,
        },
      }
    }

    if (input.operation === "company_profile") {
      const resolved = input.cik
        ? null
        : await resolveSecCikFromSymbol({
            symbol: requireField(input, "symbol"),
            fetchImpl,
            secUserAgent: config.secUserAgent,
          })
      const cik = input.cik ?? resolved?.cik
      if (!cik) {
        throw Object.assign(
          new Error("company_profile requires `symbol` or `cik`."),
          {
            code: "INVALID_INPUT",
            retryable: false,
          }
        )
      }
      const url = buildSecSubmissionsUrl(cik)
      const response = await fetchJsonWithRetry({
        url,
        provider,
        headers: {
          Accept: "application/json",
          "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
        },
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt
      if (!response.ok) {
        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data: summarizeSecSubmission(response.data, {
            ticker: input.symbol ?? resolved?.ticker,
          }),
          sources: [source],
          durationMs,
          attempts: response.attempts + (resolved?.attempts ?? 0),
          requestUrl: source.url,
        },
      }
    }

    if (input.operation === "financial_statements") {
      const resolved = input.cik
        ? null
        : await resolveSecCikFromSymbol({
            symbol: requireField(input, "symbol"),
            fetchImpl,
            secUserAgent: config.secUserAgent,
          })
      const cik = input.cik ?? resolved?.cik
      if (!cik) {
        throw Object.assign(
          new Error("financial_statements requires `symbol` or `cik`."),
          {
            code: "INVALID_INPUT",
            retryable: false,
          }
        )
      }

      const url = buildSecCompanyFactsUrl(cik)
      const response = await fetchJsonWithRetry({
        url,
        provider,
        headers: {
          Accept: "application/json",
          "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
        },
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt
      if (!response.ok) {
        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const filingSummary = await fetchLatestSecFilingSummary({
        cik,
        period: input.period ?? "annual",
        fetchImpl,
        secUserAgent: config.secUserAgent,
      })
      const source = createProviderSource(provider, input.operation, url)
      const sources = [
        source,
        ...(filingSummary.source ? [filingSummary.source] : []),
      ]
      return {
        output: {
          operation: input.operation,
          provider,
          data: summarizeSecFinancialStatement({
            data: response.data,
            cik,
            symbol: input.symbol ?? resolved?.ticker,
            filing: filingSummary.filing,
            statementType: input.statementType ?? "income",
            period: input.period ?? "annual",
          }),
          sources,
          durationMs,
          attempts:
            response.attempts +
            (resolved?.attempts ?? 0) +
            filingSummary.attempts,
          requestUrl: source.url,
        },
      }
    }

    if (input.operation === "sec_company_facts") {
      const resolved = input.cik
        ? null
        : await resolveSecCikFromSymbol({
            symbol: requireField(input, "symbol"),
            fetchImpl,
            secUserAgent: config.secUserAgent,
          })
      const cik = input.cik ?? resolved?.cik
      if (!cik) {
        throw Object.assign(
          new Error("sec_company_facts requires `symbol` or `cik`."),
          {
            code: "INVALID_INPUT",
            retryable: false,
          }
        )
      }

      const url = buildSecCompanyFactsUrl(cik)
      const response = await fetchJsonWithRetry({
        url,
        provider,
        headers: {
          Accept: "application/json",
          "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
        },
        fetchImpl,
      })
      const durationMs = Date.now() - startedAt
      if (!response.ok) {
        return {
          error: {
            message: response.message,
            code: response.code,
            operation: input.operation,
            provider,
            retryable: response.retryable,
            attempts: response.attempts,
            durationMs,
          },
        }
      }

      const source = createProviderSource(provider, input.operation, url)
      return {
        output: {
          operation: input.operation,
          provider,
          data: summarizeSecCompanyFacts({
            data: response.data,
            cik,
            symbol: input.symbol ?? resolved?.ticker,
          }),
          sources: [source],
          durationMs,
          attempts: response.attempts + (resolved?.attempts ?? 0),
          requestUrl: source.url,
        },
      }
    }

    const url = buildSecUrl(input)
    const response = await fetchJsonWithRetry({
      url,
      provider,
      headers: {
        Accept: "application/json",
        "User-Agent": getConfiguredSecUserAgent(config.secUserAgent),
      },
      fetchImpl,
    })
    const durationMs = Date.now() - startedAt
    if (!response.ok) {
      return {
        error: {
          message: response.message,
          code: response.code,
          operation: input.operation,
          provider,
          retryable: response.retryable,
          attempts: response.attempts,
          durationMs,
        },
      }
    }

    const source = createProviderSource(provider, input.operation, url)
    return {
      output: {
        operation: input.operation,
        provider,
        data: response.data,
        sources: [source],
        durationMs,
        attempts: response.attempts,
        requestUrl: source.url,
      },
    }
  } catch (error) {
    const record = asRecord(error)
    const code = toOptionalString(record?.code) ?? "INVALID_INPUT"
    const retryable =
      typeof record?.retryable === "boolean"
        ? record.retryable
        : classifyFinanceDataRetry({ code })

    return {
      error: {
        message:
          toOptionalString(record?.message) ??
          (error instanceof Error
            ? error.message
            : "Finance data request failed."),
        code,
        operation: input.operation,
        provider,
        retryable,
        attempts: 0,
        durationMs: Date.now() - startedAt,
      },
    }
  }
}

function parseToolResultPayload(
  value: unknown
): FinanceDataToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  return {
    ...(asRecord(normalized.output)
      ? { output: normalized.output as FinanceDataToolOutput }
      : {}),
    ...(asRecord(normalized.error)
      ? { error: normalized.error as FinanceDataToolErrorPayload }
      : {}),
  }
}

export function createAiSdkFinanceDataTools(
  config: FinanceDataToolConfig = {}
) {
  return {
    finance_data: tool({
      description:
        "Retrieve normalized finance data for broad-market analysis. Use provider_status first when the user asks what providers or capabilities are available; do not probe individual operations to determine availability after provider_status reports a provider unavailable. Use for company/symbol search, quotes, company profiles, historical prices, financial statements, SEC company facts, FRED macro/rates series, and provider status checks. Use web search for market news and use code execution for calculations.",
      inputSchema: financeDataInputSchema,
      execute: async (input) => runFinanceDataOperation(input, config),
    }),
  }
}

export function isAiSdkFinanceDataToolName(
  value: unknown
): value is FinanceDataToolName {
  return value === FINANCE_DATA_TOOL_NAME
}

export function getAiSdkFinanceDataToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkFinanceDataToolCallMetadata | null {
  if (part?.toolName !== FINANCE_DATA_TOOL_NAME) {
    return null
  }

  const inputRecord = asRecord(part.input)
  const operation = toOptionalString(inputRecord?.operation)
  const provider = toOptionalString(inputRecord?.provider)

  return {
    callId: part.toolCallId,
    toolName: FINANCE_DATA_TOOL_NAME,
    label: getToolLabel(part.input),
    ...(operation ? { operation } : {}),
    ...(provider ? { provider } : {}),
    attempt: 1,
  }
}

export function getAiSdkFinanceDataToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkFinanceDataToolResultMetadata | null {
  if (part?.toolName !== FINANCE_DATA_TOOL_NAME) {
    return null
  }

  const payload = parseToolResultPayload(part.output)
  if (!payload) {
    return {
      callId: part.toolCallId,
      toolName: FINANCE_DATA_TOOL_NAME,
      status: "error",
      sources: [],
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName: FINANCE_DATA_TOOL_NAME,
      status: "error",
      sources: [],
      operation: payload.error.operation,
      provider: payload.error.provider,
      attempt: payload.error.attempts,
      durationMs: payload.error.durationMs,
      errorCode: payload.error.code,
      retryable: payload.error.retryable,
    }
  }

  return {
    callId: part.toolCallId,
    toolName: FINANCE_DATA_TOOL_NAME,
    status: "success",
    sources: payload.output?.sources ?? [],
    operation: payload.output?.operation,
    provider: payload.output?.provider,
    attempt: payload.output?.attempts,
    durationMs: payload.output?.durationMs,
    retryable: false,
  }
}
