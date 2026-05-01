import type { MessageSource } from "@/lib/shared"

type FinanceDataSourceProvider = "fmp" | "sec" | "fred" | "stooq"
type FinanceDataSourceOperation =
  | "provider_status"
  | "symbol_search"
  | "quote"
  | "company_profile"
  | "historical_prices"
  | "financial_statements"
  | "sec_company_facts"
  | "fred_series"

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

export function createFinanceDataSourceId(
  parts: readonly string[],
  sourceUrl: string
): string {
  return `finance_data-${parts.join("-")}-${hashSourceId(sourceUrl)}`
}

export function createFinanceDataProviderSource(
  provider: FinanceDataSourceProvider,
  operation: FinanceDataSourceOperation,
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
    id: createFinanceDataSourceId([provider, operation], sourceUrl),
    url: sourceUrl,
    title,
  }
}
