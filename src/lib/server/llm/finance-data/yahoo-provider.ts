/**
 * Yahoo Finance provider for the `finance_data` tool.
 *
 * Wraps the community-maintained `yahoo-finance2` client (which speaks the same
 * undocumented Yahoo endpoints as Python's yfinance, with crumb/cookie + rate
 * limit handling built in). This is a no-API-key breadth/fallback provider:
 * it covers rich quotes, non-US fundamentals, analyst targets, and options that
 * the SEC/Stooq stack cannot, but Yahoo data is unofficial, so SEC/FRED
 * remain the citation-grade primaries for high-stakes answers.
 *
 * Every call passes `validateResult: false` so the library does not throw when
 * Yahoo drifts its schema; we normalize the raw payloads defensively instead.
 * The pure `normalize*` helpers are exported for unit testing with fixtures.
 */

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource } from "@/lib/shared"

import { createFinanceDataProviderSource } from "./sources"

export interface YahooOperationInput {
  operation: string
  symbol?: string
  query?: string
  from?: string
  to?: string
  limit?: number
  statementType?: "income" | "balance_sheet" | "cash_flow"
  period?: "annual" | "quarter"
}

export interface YahooProviderResult {
  data: unknown
  source: MessageSource
}

/** Error carrying the retry/classification metadata the tool's catch expects. */
export class YahooProviderError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, code: string, retryable: boolean) {
    super(message)
    this.name = "YahooProviderError"
    this.code = code
    this.retryable = retryable
  }
}

function providerError(
  message: string,
  code: string,
  retryable: boolean
): YahooProviderError {
  return new YahooProviderError(message, code, retryable)
}

// Reference yahoo-finance2's type without a runtime value import so the heavy
// module stays lazy (see getYahooClient). The inline import() type-query is the
// right tool here; a top-level `import type` of its const default export
// resolves to a value, not a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type YahooClient = InstanceType<(typeof import("yahoo-finance2"))["default"]>

let cachedClient: YahooClient | null = null

async function getYahooClient(): Promise<YahooClient> {
  if (!cachedClient) {
    // Loaded lazily: yahoo-finance2 pulls in a sizable dependency tree, so the
    // finance tool only pays that cost when a Yahoo operation actually runs
    // (and pure normalizers can be imported without it, e.g. in tests).
    const { default: YahooFinance } = await import("yahoo-finance2")
    cachedClient = new YahooFinance({
      // Don't print the periodic Yahoo survey/usage notices to server logs.
      suppressNotices: ["yahooSurvey"],
    })
  }
  return cachedClient
}

// --- Value coercion (Yahoo returns plain numbers or { raw, fmt } objects) ----

function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const record = asRecord(value)
  if (record && "raw" in record) {
    return num(record.raw)
  }
  return null
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Yahoo epochs are seconds (~1e9–1e10 for recent dates). Treat anything
    // past 1e12 as already in milliseconds and pass it through; scale the rest.
    const ms = value > 1e12 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const str = asString(value)
  if (str) {
    const date = new Date(str)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const record = asRecord(value)
  if (record) {
    if (record.fmt !== undefined) {
      return toIso(record.fmt)
    }
    if (record.raw !== undefined) {
      return toIso(record.raw)
    }
  }
  return null
}

function toIsoDate(value: unknown): string | null {
  return toIso(value)?.slice(0, 10) ?? null
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(250, limit ?? fallback))
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

function requireSymbol(input: YahooOperationInput): string {
  const symbol = input.symbol?.trim()
  if (!symbol) {
    throw providerError(
      `${input.operation} requires \`symbol\`.`,
      "INVALID_INPUT",
      false
    )
  }
  return normalizeSymbol(symbol)
}

// --- Source URLs (human-viewable Yahoo pages, for citations) -----------------

type YahooSourceKind =
  | "quote"
  | "history"
  | "profile"
  | "financials"
  | "analysis"
  | "options"
  | "lookup"

const YAHOO_PAGE_SUFFIX: Record<Exclude<YahooSourceKind, "lookup">, string> = {
  quote: "",
  history: "/history",
  profile: "/profile",
  financials: "/financials",
  analysis: "/analysis",
  options: "/options",
}

export function buildYahooSourceUrl(
  kind: YahooSourceKind,
  symbolOrQuery: string
): URL {
  if (kind === "lookup") {
    const url = new URL("https://finance.yahoo.com/lookup")
    url.searchParams.set("s", symbolOrQuery)
    return url
  }
  const base = `https://finance.yahoo.com/quote/${encodeURIComponent(
    normalizeSymbol(symbolOrQuery)
  )}`
  return new URL(`${base}${YAHOO_PAGE_SUFFIX[kind]}`)
}

function yahooSource(
  operation:
    | "quote"
    | "historical_prices"
    | "company_profile"
    | "financial_statements"
    | "symbol_search"
    | "analyst_recommendations"
    | "options_chain",
  kind: YahooSourceKind,
  symbolOrQuery: string
): MessageSource {
  return createFinanceDataProviderSource(
    "yahoo",
    operation,
    buildYahooSourceUrl(kind, symbolOrQuery)
  )
}

// --- Normalizers (pure; exported for tests) ----------------------------------

export function normalizeYahooQuote(raw: unknown, symbol: string) {
  const record = asRecord(raw)
  const price = num(record?.regularMarketPrice)
  if (!record || price === null) {
    throw providerError(
      "Yahoo quote is unavailable.",
      "QUOTE_UNAVAILABLE",
      true
    )
  }
  return {
    symbol: asString(record.symbol) ?? normalizeSymbol(symbol),
    name: asString(record.longName) ?? asString(record.shortName) ?? null,
    price,
    change: num(record.regularMarketChange),
    changePercent: num(record.regularMarketChangePercent),
    open: num(record.regularMarketOpen),
    dayHigh: num(record.regularMarketDayHigh),
    dayLow: num(record.regularMarketDayLow),
    previousClose: num(record.regularMarketPreviousClose),
    volume: num(record.regularMarketVolume),
    marketCap: num(record.marketCap),
    trailingPE: num(record.trailingPE),
    forwardPE: num(record.forwardPE),
    epsTrailingTwelveMonths: num(record.epsTrailingTwelveMonths),
    fiftyTwoWeekHigh: num(record.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(record.fiftyTwoWeekLow),
    currency: asString(record.currency),
    exchange:
      asString(record.fullExchangeName) ?? asString(record.exchange) ?? null,
    marketState: asString(record.marketState),
    asOf: toIso(record.regularMarketTime),
  }
}

export function normalizeYahooHistorical(
  raw: unknown,
  symbol: string,
  input: YahooOperationInput
) {
  const record = asRecord(raw)
  const quotes = Array.isArray(record?.quotes) ? record.quotes : []
  const rows = quotes.flatMap((entry) => {
    const quote = asRecord(entry)
    const date = toIsoDate(quote?.date)
    const close = num(quote?.close)
    if (!date || close === null) {
      return []
    }
    return [
      {
        date,
        open: num(quote?.open),
        high: num(quote?.high),
        low: num(quote?.low),
        close,
        adjClose: num(quote?.adjclose),
        volume: num(quote?.volume),
      },
    ]
  })

  if (rows.length === 0) {
    throw providerError(
      "Yahoo historical prices are unavailable.",
      "HISTORICAL_PRICES_UNAVAILABLE",
      true
    )
  }

  const limit = clampLimit(input.limit, 30)
  return {
    symbol: normalizeSymbol(symbol),
    interval: "1d",
    rows: rows.slice(-limit),
    rowCount: Math.min(rows.length, limit),
    totalRowsAvailable: rows.length,
    truncated: rows.length > limit,
  }
}

export function normalizeYahooProfile(raw: unknown, symbol: string) {
  const record = asRecord(raw)
  const assetProfile = asRecord(record?.assetProfile)
  const summaryProfile = asRecord(record?.summaryProfile)
  const price = asRecord(record?.price)
  const profile = assetProfile ?? summaryProfile
  if (!profile && !price) {
    throw providerError(
      "Yahoo company profile is unavailable.",
      "COMPANY_PROFILE_UNAVAILABLE",
      true
    )
  }
  return {
    symbol: normalizeSymbol(symbol),
    name:
      asString(price?.longName) ??
      asString(price?.shortName) ??
      normalizeSymbol(symbol),
    exchange:
      asString(price?.exchangeName) ?? asString(price?.exchange) ?? null,
    sector: asString(profile?.sector),
    industry: asString(profile?.industry),
    country: asString(profile?.country),
    city: asString(profile?.city),
    website: asString(profile?.website),
    fullTimeEmployees: num(profile?.fullTimeEmployees),
    marketCap: num(price?.marketCap),
    currency: asString(price?.currency),
    description: asString(profile?.longBusinessSummary),
  }
}

const STATEMENT_MODULE = {
  income: {
    annual: "incomeStatementHistory",
    quarter: "incomeStatementHistoryQuarterly",
    arrayKey: "incomeStatementHistory",
  },
  balance_sheet: {
    annual: "balanceSheetHistory",
    quarter: "balanceSheetHistoryQuarterly",
    arrayKey: "balanceSheetStatements",
  },
  cash_flow: {
    annual: "cashflowStatementHistory",
    quarter: "cashflowStatementHistoryQuarterly",
    arrayKey: "cashflowStatements",
  },
} as const

const STATEMENT_FIELDS: Record<
  "income" | "balance_sheet" | "cash_flow",
  readonly string[]
> = {
  income: [
    "totalRevenue",
    "costOfRevenue",
    "grossProfit",
    "operatingIncome",
    "ebit",
    "incomeBeforeTax",
    "incomeTaxExpense",
    "netIncome",
    "researchDevelopment",
  ],
  balance_sheet: [
    "totalAssets",
    "totalCurrentAssets",
    "cash",
    "shortTermInvestments",
    "totalLiab",
    "totalCurrentLiabilities",
    "longTermDebt",
    "totalStockholderEquity",
    "retainedEarnings",
  ],
  cash_flow: [
    "totalCashFromOperatingActivities",
    "capitalExpenditures",
    "totalCashflowsFromInvestingActivities",
    "totalCashFromFinancingActivities",
    "netIncome",
    "depreciation",
    "dividendsPaid",
    "repurchaseOfStock",
  ],
}

export function normalizeYahooFinancials(
  raw: unknown,
  symbol: string,
  input: YahooOperationInput
) {
  const statementType = input.statementType ?? "income"
  const config = STATEMENT_MODULE[statementType]
  const record = asRecord(raw)
  const period = input.period ?? "annual"
  const moduleName = period === "quarter" ? config.quarter : config.annual
  const container = asRecord(record?.[moduleName])
  const statementsRaw = container?.[config.arrayKey]
  const statements: unknown[] = Array.isArray(statementsRaw)
    ? statementsRaw
    : []

  const fields = STATEMENT_FIELDS[statementType]
  const periods = statements.flatMap((entry) => {
    const statement = asRecord(entry)
    const endDate = toIsoDate(statement?.endDate)
    if (!statement || !endDate) {
      return []
    }
    const values: Record<string, number | null> = {}
    for (const field of fields) {
      values[field] = num(statement[field])
    }
    if (statementType === "cash_flow" && values.capitalExpenditures !== null) {
      const operating = values.totalCashFromOperatingActivities
      values.freeCashFlow =
        operating !== null && operating !== undefined
          ? operating + (values.capitalExpenditures ?? 0)
          : null
    }
    return [{ endDate, ...values }]
  })

  if (periods.length === 0) {
    throw providerError(
      "Yahoo financial statements are unavailable.",
      "FINANCIAL_STATEMENTS_UNAVAILABLE",
      true
    )
  }

  return {
    symbol: normalizeSymbol(symbol),
    statementType,
    period,
    currency: "reported",
    periods,
  }
}

export function normalizeYahooSearch(
  raw: unknown,
  query: string,
  limit: number
) {
  const record = asRecord(raw)
  const quotes = Array.isArray(record?.quotes) ? record.quotes : []
  const rows = quotes.flatMap((entry) => {
    const quote = asRecord(entry)
    const symbol = asString(quote?.symbol)
    if (!symbol) {
      return []
    }
    return [
      {
        symbol,
        name:
          asString(quote?.shortname) ??
          asString(quote?.longname) ??
          asString(quote?.shortName) ??
          null,
        exchange:
          asString(quote?.exchDisp) ?? asString(quote?.exchange) ?? null,
        type: asString(quote?.quoteType) ?? asString(quote?.typeDisp) ?? null,
      },
    ]
  })
  return {
    query,
    rows: rows.slice(0, limit),
    rowCount: Math.min(rows.length, limit),
  }
}

export function normalizeYahooRecommendations(raw: unknown, symbol: string) {
  const record = asRecord(raw)
  const financialData = asRecord(record?.financialData)
  const recommendationTrend = asRecord(record?.recommendationTrend)
  const trendRaw = Array.isArray(recommendationTrend?.trend)
    ? recommendationTrend.trend
    : []
  const trend = trendRaw.flatMap((entry) => {
    const row = asRecord(entry)
    const period = asString(row?.period)
    if (!period) {
      return []
    }
    return [
      {
        period,
        strongBuy: num(row?.strongBuy),
        buy: num(row?.buy),
        hold: num(row?.hold),
        sell: num(row?.sell),
        strongSell: num(row?.strongSell),
      },
    ]
  })

  const hasData =
    trend.length > 0 ||
    num(financialData?.targetMeanPrice) !== null ||
    asString(financialData?.recommendationKey) !== null
  if (!hasData) {
    throw providerError(
      "Yahoo analyst data is unavailable.",
      "ANALYST_DATA_UNAVAILABLE",
      true
    )
  }

  return {
    symbol: normalizeSymbol(symbol),
    recommendationKey: asString(financialData?.recommendationKey),
    numberOfAnalystOpinions: num(financialData?.numberOfAnalystOpinions),
    currentPrice: num(financialData?.currentPrice),
    targetMeanPrice: num(financialData?.targetMeanPrice),
    targetHighPrice: num(financialData?.targetHighPrice),
    targetLowPrice: num(financialData?.targetLowPrice),
    targetMedianPrice: num(financialData?.targetMedianPrice),
    currency: asString(financialData?.financialCurrency),
    trend,
  }
}

const OPTIONS_CONTRACT_CAP = 24

function normalizeOptionContracts(value: unknown) {
  const list = Array.isArray(value) ? value : []
  const contracts = list.flatMap((entry) => {
    const contract = asRecord(entry)
    const strike = num(contract?.strike)
    if (strike === null) {
      return []
    }
    return [
      {
        contractSymbol: asString(contract?.contractSymbol),
        strike,
        lastPrice: num(contract?.lastPrice),
        bid: num(contract?.bid),
        ask: num(contract?.ask),
        volume: num(contract?.volume),
        openInterest: num(contract?.openInterest),
        impliedVolatility: num(contract?.impliedVolatility),
        inTheMoney:
          typeof contract?.inTheMoney === "boolean"
            ? contract.inTheMoney
            : null,
      },
    ]
  })
  return {
    contracts: contracts.slice(0, OPTIONS_CONTRACT_CAP),
    totalAvailable: contracts.length,
    truncated: contracts.length > OPTIONS_CONTRACT_CAP,
  }
}

export function normalizeYahooOptions(raw: unknown, symbol: string) {
  const record = asRecord(raw)
  const expirationDatesRaw = Array.isArray(record?.expirationDates)
    ? record.expirationDates
    : []
  const expirationDates = expirationDatesRaw
    .map((value) => toIsoDate(value))
    .filter((value): value is string => Boolean(value))
  const chains = Array.isArray(record?.options) ? record.options : []
  const nearest = asRecord(chains[0])
  if (!nearest) {
    throw providerError(
      "Yahoo options chain is unavailable.",
      "OPTIONS_UNAVAILABLE",
      true
    )
  }
  const quote = asRecord(record?.quote)
  return {
    symbol: normalizeSymbol(symbol),
    underlyingPrice: num(quote?.regularMarketPrice),
    currency: asString(quote?.currency),
    expirationDates,
    expiration: toIsoDate(nearest.expirationDate),
    calls: normalizeOptionContracts(nearest.calls),
    puts: normalizeOptionContracts(nearest.puts),
  }
}

// --- Dispatch ----------------------------------------------------------------

function defaultHistoricalFrom(): string {
  // ~6 months of daily candles by default when no `from` is provided.
  const date = new Date()
  date.setUTCMonth(date.getUTCMonth() - 6)
  return date.toISOString().slice(0, 10)
}

/** Run a single Yahoo operation, returning normalized data + a citation. */
export async function runYahooFinanceOperation(
  input: YahooOperationInput
): Promise<YahooProviderResult> {
  const client = await getYahooClient()

  try {
    switch (input.operation) {
      case "quote": {
        const symbol = requireSymbol(input)
        const raw: unknown = await client.quote(symbol, undefined, {
          validateResult: false,
        })
        return {
          data: normalizeYahooQuote(raw, symbol),
          source: yahooSource("quote", "quote", symbol),
        }
      }
      case "historical_prices": {
        const symbol = requireSymbol(input)
        const raw: unknown = await client.chart(
          symbol,
          {
            period1: input.from ?? defaultHistoricalFrom(),
            ...(input.to ? { period2: input.to } : {}),
            interval: "1d",
          },
          { validateResult: false }
        )
        return {
          data: normalizeYahooHistorical(raw, symbol, input),
          source: yahooSource("historical_prices", "history", symbol),
        }
      }
      case "company_profile": {
        const symbol = requireSymbol(input)
        const raw: unknown = await client.quoteSummary(
          symbol,
          { modules: ["assetProfile", "summaryProfile", "price"] },
          { validateResult: false }
        )
        return {
          data: normalizeYahooProfile(raw, symbol),
          source: yahooSource("company_profile", "profile", symbol),
        }
      }
      case "financial_statements": {
        const symbol = requireSymbol(input)
        const statementType = input.statementType ?? "income"
        const period = input.period ?? "annual"
        const moduleName =
          period === "quarter"
            ? STATEMENT_MODULE[statementType].quarter
            : STATEMENT_MODULE[statementType].annual
        const raw: unknown = await client.quoteSummary(
          symbol,
          { modules: [moduleName] },
          { validateResult: false }
        )
        return {
          data: normalizeYahooFinancials(raw, symbol, input),
          source: yahooSource("financial_statements", "financials", symbol),
        }
      }
      case "symbol_search": {
        const query = input.query?.trim()
        if (!query) {
          throw providerError(
            "symbol_search requires `query`.",
            "INVALID_INPUT",
            false
          )
        }
        const limit = clampLimit(input.limit, 10)
        const raw: unknown = await client.search(
          query,
          { quotesCount: limit, newsCount: 0 },
          { validateResult: false }
        )
        return {
          data: normalizeYahooSearch(raw, query, limit),
          source: yahooSource("symbol_search", "lookup", query),
        }
      }
      case "analyst_recommendations": {
        const symbol = requireSymbol(input)
        const raw: unknown = await client.quoteSummary(
          symbol,
          { modules: ["financialData", "recommendationTrend"] },
          { validateResult: false }
        )
        return {
          data: normalizeYahooRecommendations(raw, symbol),
          source: yahooSource("analyst_recommendations", "analysis", symbol),
        }
      }
      case "options_chain": {
        const symbol = requireSymbol(input)
        const raw: unknown = await client.options(symbol, undefined, {
          validateResult: false,
        })
        return {
          data: normalizeYahooOptions(raw, symbol),
          source: yahooSource("options_chain", "options", symbol),
        }
      }
      default:
        throw providerError(
          `${input.operation} is not supported by Yahoo Finance.`,
          "OPERATION_UNSUPPORTED",
          false
        )
    }
  } catch (error) {
    if (error instanceof YahooProviderError) {
      throw error
    }
    const record = asRecord(error)
    const message =
      asString(record?.message) ??
      (error instanceof Error ? error.message : "Yahoo Finance request failed.")
    // Yahoo throttling/transient network failures are retryable; treat
    // not-found / validation issues as terminal.
    const retryable =
      /rate.?limit|too many requests|timeout|fetch failed|network|ECONN|ETIMEDOUT|crumb/i.test(
        message
      )
    throw providerError(message, "YAHOO_REQUEST_FAILED", retryable)
  }
}
