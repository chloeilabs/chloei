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
