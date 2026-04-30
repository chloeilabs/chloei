const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3"
const FRED_BASE_URL = "https://api.stlouisfed.org/fred"

interface FinanceProviderUrlInput {
  from?: string
  limit?: number
  operation:
    | "company_profile"
    | "financial_statements"
    | "fred_series"
    | "historical_prices"
    | "provider_status"
    | "quote"
    | "sec_company_facts"
    | "symbol_search"
  period?: "annual" | "quarter"
  query?: string
  seriesId?: string
  statementType?: "income" | "balance_sheet" | "cash_flow"
  symbol?: string
  to?: string
}

function requireField(
  input: FinanceProviderUrlInput,
  field: keyof FinanceProviderUrlInput
): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${input.operation} requires \`${field}\`.`)
  }

  return value.trim()
}

function normalizeLimit(input: FinanceProviderUrlInput, fallback: number) {
  return Math.max(1, Math.min(250, input.limit ?? fallback))
}

function getStatementEndpoint(
  statementType: FinanceProviderUrlInput["statementType"]
): string {
  if (statementType === "balance_sheet") {
    return "balance-sheet-statement"
  }

  if (statementType === "cash_flow") {
    return "cash-flow-statement"
  }

  return "income-statement"
}

export function buildFmpUrl(
  input: FinanceProviderUrlInput,
  apiKey: string
): URL {
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

export function buildFmpStatusUrl(apiKey: string): URL {
  const url = new URL(`${FMP_BASE_URL}/quote-short/AAPL`)
  url.searchParams.set("apikey", apiKey)
  return url
}

export function buildFredUrl(
  input: FinanceProviderUrlInput,
  apiKey: string
): URL {
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

export function buildFredStatusUrl(apiKey: string): URL {
  const url = new URL(`${FRED_BASE_URL}/series/observations`)
  url.searchParams.set("series_id", "FEDFUNDS")
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("file_type", "json")
  url.searchParams.set("sort_order", "desc")
  url.searchParams.set("limit", "1")
  return url
}
