import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import { createLogger } from "@/lib/logger"
import type { MessageSource, ToolName } from "@/lib/shared"

import {
  buildFmpStatusUrl,
  buildFmpUrl,
  buildFredStatusUrl,
  buildFredUrl,
} from "./finance-data/provider-urls"
import {
  classifyFinanceDataRetry,
  fetchJsonWithRetry,
  fetchTextWithRetry,
} from "./finance-data/retry"
import {
  type SecFilingSummary,
  summarizeSecCompanyFacts,
  summarizeSecFinancialStatement,
} from "./finance-data/sec-company-facts"
import {
  createFinanceDataProviderSource as createProviderSource,
  createFinanceDataSourceId,
} from "./finance-data/sources"
import {
  buildStooqHistoricalPricesUrl,
  buildStooqQuoteUrl,
  parseStooqHistoricalPricesCsv,
  parseStooqQuoteCsv,
} from "./finance-data/stooq-provider"

const FINANCE_DATA_TOOL_NAME = "finance_data" as const
const SEC_COMPANY_FACTS_BASE_URL = "https://data.sec.gov/api/xbrl/companyfacts"
const SEC_COMPANY_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions"
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

export { classifyFinanceDataRetry } from "./finance-data/retry"

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

interface FinanceDataEvidenceSupplement {
  label: string
  provider: string
  data: unknown
  sources: MessageSource[]
}

interface FinanceDataEvidenceContext {
  context: string | null
  sources: MessageSource[]
  outputs: FinanceDataToolOutput[]
  supplements: FinanceDataEvidenceSupplement[]
  errors: FinanceDataToolErrorPayload[]
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

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
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
  input: FinanceDataToolInput,
  config: FinanceDataToolConfig = {}
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

  if (input.operation === "quote" || input.operation === "historical_prices") {
    return config.fmpApiKey?.trim() ? "fmp" : "stooq"
  }

  if (input.operation === "financial_statements") {
    return config.fmpApiKey?.trim() ? "fmp" : "sec"
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

function canFallbackFromFmpError(code: string | undefined): boolean {
  const normalized = code?.trim().toUpperCase()
  return normalized === "HTTP_401" || normalized === "HTTP_403"
}

function normalizeFmpQuoteData(data: unknown) {
  const row = Array.isArray(data) ? asRecord(data[0]) : asRecord(data)
  if (!row) {
    throw Object.assign(new Error("FMP quote data is unavailable."), {
      code: "QUOTE_UNAVAILABLE",
      retryable: true,
    })
  }

  const close = toOptionalNumber(row.price)
  if (close === null) {
    throw Object.assign(new Error("FMP quote data is unavailable."), {
      code: "QUOTE_UNAVAILABLE",
      retryable: true,
    })
  }

  return {
    symbol: toOptionalString(row.symbol),
    date: toOptionalString(row.date),
    time: toOptionalString(row.timestamp),
    open: toOptionalNumber(row.open),
    high: toOptionalNumber(row.dayHigh),
    low: toOptionalNumber(row.dayLow),
    close,
    volume: toOptionalNumber(row.volume),
    name: toOptionalString(row.name),
    marketCap: toOptionalNumber(row.marketCap),
    delayed: false,
  }
}

function normalizeFmpHistoricalPricesData(
  data: unknown,
  input: FinanceDataToolInput
) {
  const record = asRecord(data)
  const rows = (Array.isArray(record?.historical) ? record.historical : [])
    .flatMap((entry) => {
      const row = asRecord(entry)
      const close = toOptionalNumber(row?.close)
      const date = toOptionalString(row?.date)
      if (!date || close === null) {
        return []
      }

      return [
        {
          date,
          open: toOptionalNumber(row?.open),
          high: toOptionalNumber(row?.high),
          low: toOptionalNumber(row?.low),
          close,
          volume: toOptionalNumber(row?.volume),
        },
      ]
    })
    .reverse()

  if (rows.length === 0) {
    throw Object.assign(new Error("FMP historical prices are unavailable."), {
      code: "HISTORICAL_PRICES_UNAVAILABLE",
      retryable: true,
    })
  }

  const limit = normalizeLimit(input, 30)
  return {
    symbol:
      toOptionalString(record?.symbol) ??
      normalizeTickerSymbol(requireField(input, "symbol")),
    interval: "1d",
    rows: rows.slice(-limit),
    rowCount: Math.min(rows.length, limit),
    totalRowsAvailable: rows.length,
    truncated: rows.length > limit,
  }
}

function isTruthyProviderFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value
  }

  const normalized = toOptionalString(value)?.toLowerCase()
  return normalized === "true" || normalized === "1" || normalized === "yes"
}

function normalizeFmpCompanyProfileData(
  data: unknown,
  input: FinanceDataToolInput
) {
  const row = Array.isArray(data) ? asRecord(data[0]) : asRecord(data)
  if (!row) {
    throw Object.assign(new Error("FMP company profile data is unavailable."), {
      code: "COMPANY_PROFILE_UNAVAILABLE",
      retryable: true,
    })
  }

  const symbol =
    toOptionalString(row.symbol) ??
    normalizeTickerSymbol(requireField(input, "symbol"))
  const exchange =
    toOptionalString(row.exchangeShortName) ?? toOptionalString(row.exchange)
  const city = toOptionalString(row.city)
  const stateOrCountry =
    toOptionalString(row.state) ?? toOptionalString(row.country)

  return {
    cik: toOptionalString(row.cik),
    name: toOptionalString(row.companyName) ?? toOptionalString(row.name),
    tickers: symbol ? [symbol] : [],
    exchanges: exchange ? [exchange] : [],
    entityType: isTruthyProviderFlag(row.isEtf) ? "ETF" : undefined,
    sic: toOptionalString(row.sic),
    sicDescription: toOptionalString(row.industry),
    ownerOrg: toOptionalString(row.sector),
    category: toOptionalString(row.exchange),
    fiscalYearEnd: toOptionalString(row.fiscalYearEnd),
    stateOfIncorporation: toOptionalString(row.state),
    businessAddress:
      city || stateOrCountry
        ? {
            city,
            stateOrCountry,
          }
        : undefined,
    marketCap: toOptionalNumber(row.mktCap ?? row.marketCap),
    website: toOptionalString(row.website),
    description: toOptionalString(row.description),
  }
}

function normalizeFmpAutoData(data: unknown, input: FinanceDataToolInput) {
  if (input.operation === "quote") {
    return normalizeFmpQuoteData(data)
  }

  if (input.operation === "company_profile") {
    return normalizeFmpCompanyProfileData(data, input)
  }

  if (input.operation === "historical_prices") {
    return normalizeFmpHistoricalPricesData(data, input)
  }

  return data
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
            id: createFinanceDataSourceId(["sec", "filing"], filing.url),
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

export async function runFinanceDataOperation(
  input: FinanceDataToolInput,
  config: FinanceDataToolConfig = {}
): Promise<FinanceDataToolResultPayload> {
  const startedAt = Date.now()
  const fetchImpl = config.fetchImpl ?? fetch
  const requestedProvider = normalizeProvider(input.provider)
  const provider = resolveProvider(input, config)

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
        if (fallbackProvider && canFallbackFromFmpError(response.code)) {
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
      let data = response.data
      if (
        requestedProvider === "auto" ||
        input.operation === "company_profile"
      ) {
        try {
          data = normalizeFmpAutoData(response.data, input)
        } catch (error) {
          const record = asRecord(error)
          const code = toOptionalString(record?.code) ?? "NORMALIZATION_FAILED"
          return {
            error: {
              message:
                toOptionalString(record?.message) ??
                (error instanceof Error
                  ? error.message
                  : "FMP response normalization failed."),
              code,
              operation: input.operation,
              provider,
              retryable:
                typeof record?.retryable === "boolean"
                  ? record.retryable
                  : classifyFinanceDataRetry({ code }),
              attempts: response.attempts,
              durationMs,
            },
          }
        }
      }
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

const FINANCE_EVIDENCE_COMMON_SYMBOLS: readonly {
  symbol: string
  marketCapSlug?: string
  patterns: readonly RegExp[]
}[] = [
  {
    symbol: "AAPL",
    marketCapSlug: "apple",
    patterns: [/\bapple(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "MSFT",
    marketCapSlug: "microsoft",
    patterns: [/\bmicrosoft(?:\s+corp\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "NVDA",
    marketCapSlug: "nvidia",
    patterns: [/\bnvidia(?:\s+corp\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "TSLA",
    marketCapSlug: "tesla",
    patterns: [/\btesla(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "AMZN",
    marketCapSlug: "amazon",
    patterns: [/\bamazon(?:\.com)?(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "GOOGL",
    marketCapSlug: "alphabet-google",
    patterns: [/\balphabet(?:\s+inc\.?)?(?:'s)?\b/i, /\bgoogle(?:'s)?\b/i],
  },
  {
    symbol: "META",
    marketCapSlug: "meta-platforms",
    patterns: [/\bmeta(?:\s+platforms)?(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "NFLX",
    marketCapSlug: "netflix",
    patterns: [/\bnetflix(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "AVGO",
    marketCapSlug: "broadcom",
    patterns: [/\bbroadcom(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "ORCL",
    marketCapSlug: "oracle",
    patterns: [/\boracle(?:\s+corp\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "AMD",
    marketCapSlug: "amd",
    patterns: [/\badvanced micro devices(?:'s)?\b/i, /\bamd(?:'s)?\b/i],
  },
  {
    symbol: "INTC",
    marketCapSlug: "intel",
    patterns: [/\bintel(?:\s+corp\.?)?(?:'s)?\b/i],
  },
  { symbol: "IBM", marketCapSlug: "ibm", patterns: [/\bibm(?:'s)?\b/i] },
  {
    symbol: "JPM",
    marketCapSlug: "jpmorgan-chase",
    patterns: [/\bjpmorgan(?:\s+chase)?(?:'s)?\b/i],
  },
  {
    symbol: "BAC",
    marketCapSlug: "bank-of-america",
    patterns: [/\bbank of america(?:'s)?\b/i],
  },
  {
    symbol: "WMT",
    marketCapSlug: "walmart",
    patterns: [/\bwalmart(?:\s+inc\.?)?(?:'s)?\b/i],
  },
  {
    symbol: "DIS",
    marketCapSlug: "walt-disney",
    patterns: [/\bdisney(?:'s)?\b/i],
  },
  { symbol: "SPY", patterns: [/\bspdr s&p 500 etf\b/i, /\bspy\b/i] },
  { symbol: "QQQ", patterns: [/\binvesco qqq\b/i, /\bqqq\b/i] },
]

const FINANCE_EVIDENCE_IGNORED_TICKERS = new Set([
  "AI",
  "API",
  "CEO",
  "CFO",
  "CPI",
  "ETF",
  "GDP",
  "IPO",
  "LLC",
  "NASDAQ",
  "NYSE",
  "SEC",
  "USD",
])
const FINANCE_EVIDENCE_MAX_SYMBOLS = 4

function normalizeFinanceEvidenceSymbol(symbol: string): string {
  return symbol.replace(/^\$/, "").replace(/\.$/, "").trim().toUpperCase()
}

export function inferFinanceDataEvidenceSymbols(query: string): string[] {
  const candidates: { symbol: string; index: number; order: number }[] = []
  let order = 0
  const addCandidate = (symbol: string, index: number) => {
    const normalized = normalizeFinanceEvidenceSymbol(symbol)
    if (!normalized || FINANCE_EVIDENCE_IGNORED_TICKERS.has(normalized)) {
      return
    }

    candidates.push({ symbol: normalized, index, order })
    order += 1
  }

  for (const match of query.matchAll(/\$([A-Z][A-Z0-9.-]{0,9})\b/g)) {
    if (match[1]) {
      addCandidate(match[1], match.index)
    }
  }

  for (const match of query.matchAll(/\(([$A-Z][A-Z0-9.-]{0,9})\)/g)) {
    if (match[1]) {
      addCandidate(match[1], match.index)
    }
  }

  for (const match of query.matchAll(
    /\b(?:ticker|symbol)\s*[:=]?\s*([A-Z][A-Z0-9.-]{0,9})\b/gi
  )) {
    if (match[1]) {
      addCandidate(match[1], match.index)
    }
  }

  for (const entry of FINANCE_EVIDENCE_COMMON_SYMBOLS) {
    for (const pattern of entry.patterns) {
      const match = pattern.exec(query)
      if (match?.index !== undefined) {
        addCandidate(entry.symbol, match.index)
        break
      }
    }
  }

  for (const match of query.matchAll(/\b[A-Z][A-Z0-9.-]{1,9}\b/g)) {
    addCandidate(match[0], match.index)
  }

  const seen = new Set<string>()
  return candidates
    .sort((a, b) => a.index - b.index || a.order - b.order)
    .flatMap((candidate) => {
      if (seen.has(candidate.symbol)) {
        return []
      }

      seen.add(candidate.symbol)
      return [candidate.symbol]
    })
    .slice(0, FINANCE_EVIDENCE_MAX_SYMBOLS)
}

export function inferFinanceDataEvidenceSymbol(query: string): string | null {
  return inferFinanceDataEvidenceSymbols(query)[0] ?? null
}

function getMarketCapSlug(symbol: string): string | null {
  return (
    FINANCE_EVIDENCE_COMMON_SYMBOLS.find(
      (entry) => entry.symbol === normalizeFinanceEvidenceSymbol(symbol)
    )?.marketCapSlug ?? null
  )
}

function shouldFetchMarketCapEvidence(query: string): boolean {
  return /\b(market cap|market capitalization)\b/i.test(query)
}

function parseCompaniesMarketCapText(text: string): {
  valueText: string
  description?: string
} | null {
  const normalized = text.replace(/\s+/g, " ").trim()
  const sentenceMatch =
    /market cap of\s+(\$[0-9,.]+\s+(?:Trillion|Billion|Million)\s+USD)[^.]*\./i.exec(
      normalized
    )
  if (sentenceMatch?.[1]) {
    return {
      valueText: sentenceMatch[1],
      ...(sentenceMatch[0] ? { description: sentenceMatch[0] } : {}),
    }
  }

  const compactMatch = /Market Cap\s*(\$[0-9,.]+\s*[TBM])/i.exec(normalized)
  if (compactMatch?.[1]) {
    return { valueText: compactMatch[1] }
  }

  return null
}

async function fetchCompaniesMarketCapSupplement(params: {
  symbol: string
  fetchImpl: typeof fetch
}): Promise<FinanceDataEvidenceSupplement | null> {
  const slug = getMarketCapSlug(params.symbol)
  if (!slug) {
    return null
  }

  const url = new URL(`https://companiesmarketcap.com/${slug}/marketcap/`)
  const startedAt = Date.now()
  const response = await fetchTextWithRetry({
    url,
    provider: "local",
    headers: {
      Accept: "text/html",
      "User-Agent": getConfiguredSecUserAgent(undefined),
    },
    fetchImpl: params.fetchImpl,
    timeoutMs: 8_000,
  })

  if (!response.ok) {
    return null
  }

  const marketCap = parseCompaniesMarketCapText(response.data)
  if (!marketCap) {
    return null
  }

  const source: MessageSource = {
    id: createFinanceDataSourceId(["market-cap", params.symbol], String(url)),
    url: String(url),
    title: "CompaniesMarketCap",
  }

  return {
    label: "Market capitalization",
    provider: "companiesmarketcap",
    sources: [source],
    data: {
      symbol: normalizeFinanceEvidenceSymbol(params.symbol),
      marketCap,
      retrievedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
  }
}

function inferFinanceEvidenceStatementType(
  query: string
): FinanceDataToolInput["statementType"] | null {
  if (/\b(balance sheet|assets|liabilities|debt|equity)\b/i.test(query)) {
    return "balance_sheet"
  }

  if (/\b(cash flow|free cash flow|fcf|capex|operating cash)\b/i.test(query)) {
    return "cash_flow"
  }

  if (
    /\b(income statement|revenue|gross margin|operating margin|net income|earnings)\b/i.test(
      query
    )
  ) {
    return "income"
  }

  return null
}

function getFinanceEvidenceInputs(params: {
  query: string
  symbol: string
  fmpApiKey?: string
}): FinanceDataToolInput[] {
  const statementType = inferFinanceEvidenceStatementType(params.query)
  const quoteRequested =
    /\b(price|quote|stock|share price|market cap|market capitalization|volume|close|open|high|low|current|latest)\b/i.test(
      params.query
    ) || !statementType
  const profileRequested =
    /\b(company|profile|exchange|cik|filing|market cap|market capitalization|source|sources|cite|citation)\b/i.test(
      params.query
    ) || quoteRequested
  const inputs: FinanceDataToolInput[] = []

  if (quoteRequested) {
    inputs.push({
      operation: "quote",
      provider: params.fmpApiKey?.trim() ? "fmp" : "auto",
      symbol: params.symbol,
    })
  }

  if (profileRequested) {
    inputs.push({
      operation: "company_profile",
      provider: "auto",
      symbol: params.symbol,
    })
  }

  if (statementType) {
    inputs.push({
      operation: "financial_statements",
      provider: "auto",
      symbol: params.symbol,
      statementType,
      period: "annual",
    })
  }

  return inputs
}

function compactFinanceEvidenceJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  return text.length > 8_000 ? `${text.slice(0, 8_000)}\n...[truncated]` : text
}

function getUniqueFinanceEvidenceSources(
  outputs: readonly FinanceDataToolOutput[],
  supplements: readonly FinanceDataEvidenceSupplement[]
): MessageSource[] {
  const seenUrls = new Set<string>()
  return [...outputs, ...supplements].flatMap((entry) =>
    entry.sources.filter((source) => {
      const normalizedUrl = source.url.trim()
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
        return false
      }

      seenUrls.add(normalizedUrl)
      return true
    })
  )
}

function formatFinanceEvidenceContext(params: {
  query: string
  symbols: readonly string[]
  outputs: readonly FinanceDataToolOutput[]
  supplements: readonly FinanceDataEvidenceSupplement[]
  errors: readonly FinanceDataToolErrorPayload[]
}): string | null {
  if (
    params.outputs.length === 0 &&
    params.supplements.length === 0 &&
    params.errors.length === 0
  ) {
    return null
  }

  const lines = [
    "<finance_data_evidence>",
    `Query: ${params.query}`,
    `Resolved symbols: ${
      params.symbols.length > 0 ? params.symbols.join(", ") : "unresolved"
    }`,
  ]

  for (const output of params.outputs) {
    lines.push(
      "",
      `Operation: ${output.operation}`,
      `Provider: ${output.provider}`,
      `Request URL: ${output.requestUrl ?? "n/a"}`,
      `Sources: ${
        output.sources.length > 0
          ? output.sources
              .map((source) => `${source.title} (${source.url})`)
              .join("; ")
          : "none"
      }`,
      "Data:",
      compactFinanceEvidenceJson(output.data)
    )
  }

  for (const supplement of params.supplements) {
    lines.push(
      "",
      `Supplement: ${supplement.label}`,
      `Provider: ${supplement.provider}`,
      `Sources: ${
        supplement.sources.length > 0
          ? supplement.sources
              .map((source) => `${source.title} (${source.url})`)
              .join("; ")
          : "none"
      }`,
      "Data:",
      compactFinanceEvidenceJson(supplement.data)
    )
  }

  if (params.errors.length > 0) {
    lines.push("", "Errors:")
    for (const error of params.errors) {
      lines.push(
        `- ${error.operation} via ${error.provider}: ${error.code} - ${error.message}`
      )
    }
  }

  lines.push("</finance_data_evidence>")
  return lines.join("\n")
}

export async function createAiSdkFinanceDataEvidenceContext(
  params: FinanceDataToolConfig & {
    query: string
  }
): Promise<FinanceDataEvidenceContext> {
  const query = params.query.trim()
  const symbols = inferFinanceDataEvidenceSymbols(query)
  const outputs: FinanceDataToolOutput[] = []
  const supplements: FinanceDataEvidenceSupplement[] = []
  const errors: FinanceDataToolErrorPayload[] = []

  if (symbols.length === 0) {
    const error: FinanceDataToolErrorPayload = {
      message: "Unable to resolve a ticker symbol from the user prompt.",
      code: "SYMBOL_UNRESOLVED",
      operation: "symbol_search",
      provider: "local",
      retryable: false,
      attempts: 0,
      durationMs: 0,
    }
    errors.push(error)

    return {
      context: formatFinanceEvidenceContext({
        query,
        symbols,
        outputs,
        supplements,
        errors,
      }),
      sources: [],
      outputs,
      supplements,
      errors,
    }
  }

  const inputs = symbols.flatMap((symbol) =>
    getFinanceEvidenceInputs({
      query,
      symbol,
      fmpApiKey: params.fmpApiKey,
    })
  )
  const results = await Promise.all(
    inputs.map((input) => runFinanceDataOperation(input, params))
  )

  for (const result of results) {
    if (result.output) {
      outputs.push(result.output)
    }

    if (result.error) {
      errors.push(result.error)
    }
  }

  if (shouldFetchMarketCapEvidence(query)) {
    const marketCapSupplements = await Promise.all(
      symbols.map((symbol) =>
        fetchCompaniesMarketCapSupplement({
          symbol,
          fetchImpl: params.fetchImpl ?? fetch,
        })
      )
    )
    for (const supplement of marketCapSupplements) {
      if (supplement) {
        supplements.push(supplement)
      }
    }
  }

  return {
    context: formatFinanceEvidenceContext({
      query,
      symbols,
      outputs,
      supplements,
      errors,
    }),
    sources: getUniqueFinanceEvidenceSources(outputs, supplements),
    outputs,
    supplements,
    errors,
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
