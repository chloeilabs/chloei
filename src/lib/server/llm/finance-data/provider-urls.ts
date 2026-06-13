const FRED_BASE_URL = "https://api.stlouisfed.org/fred"

interface FinanceProviderUrlInput {
  from?: string
  limit?: number
  operation:
    | "analyst_recommendations"
    | "company_profile"
    | "financial_statements"
    | "fred_series"
    | "historical_prices"
    | "options_chain"
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
