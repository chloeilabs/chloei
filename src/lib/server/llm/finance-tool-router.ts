export type CuratedFinanceOperation =
  | "company_snapshot"
  | "filing_facts"
  | "financial_statements"
  | "investment_memo_math"
  | "macro_series"
  | "market_data"
  | "news_and_events"
  | "resolve_security"

export type CuratedFinanceProvider =
  | "bea"
  | "bls"
  | "census"
  | "finnhub"
  | "fmp"
  | "fred"
  | "local"
  | "openfigi"
  | "sec"
  | "stooq"
  | "tavily"
  | "tiingo"
  | "treasury"
  | "twelve_data"
  | "web_search"

export interface FinanceRouterCapabilities {
  fmpConfigured?: boolean
  fredConfigured?: boolean
  openFigiConfigured?: boolean
  premiumMarketDataConfigured?: boolean
}

export interface CuratedFinanceRoute {
  operation: CuratedFinanceOperation
  primaryProvider: CuratedFinanceProvider
  fallbackProviders: CuratedFinanceProvider[]
  financeDataOperation?:
    | "company_profile"
    | "financial_statements"
    | "fred_series"
    | "historical_prices"
    | "provider_status"
    | "quote"
    | "sec_company_facts"
    | "symbol_search"
  requiresCalculation: boolean
  sourcePolicy: "official" | "primary_or_fallback" | "search"
  rationale: string
}

function getMarketDataRoute(
  capabilities: FinanceRouterCapabilities
): CuratedFinanceRoute {
  return {
    operation: "market_data",
    primaryProvider: capabilities.fmpConfigured ? "fmp" : "stooq",
    fallbackProviders: capabilities.fmpConfigured
      ? ["stooq", "tiingo", "twelve_data"]
      : ["tiingo", "twelve_data"],
    financeDataOperation: "quote",
    requiresCalculation: false,
    sourcePolicy: "primary_or_fallback",
    rationale: capabilities.fmpConfigured
      ? "FMP is configured, so use the paid normalized provider before Stooq."
      : "FMP is unavailable, so use the free Stooq quote fallback first.",
  }
}

export function routeCuratedFinanceRequest(params: {
  operation: CuratedFinanceOperation
  capabilities?: FinanceRouterCapabilities
}): CuratedFinanceRoute {
  const capabilities = params.capabilities ?? {}

  if (params.operation === "resolve_security") {
    return {
      operation: params.operation,
      primaryProvider: capabilities.openFigiConfigured ? "openfigi" : "fmp",
      fallbackProviders: ["sec"],
      financeDataOperation: "symbol_search",
      requiresCalculation: false,
      sourcePolicy: "primary_or_fallback",
      rationale:
        "Resolve identifiers before fetching company facts so downstream tools use a stable symbol, CIK, or FIGI.",
    }
  }

  if (params.operation === "company_snapshot") {
    return {
      operation: params.operation,
      primaryProvider: capabilities.fmpConfigured ? "fmp" : "sec",
      fallbackProviders: capabilities.fmpConfigured ? ["sec"] : ["fmp"],
      financeDataOperation: "company_profile",
      requiresCalculation: false,
      sourcePolicy: "primary_or_fallback",
      rationale:
        "Prefer FMP company profile data when configured, then verify identifiers against SEC submissions.",
    }
  }

  if (params.operation === "market_data") {
    return getMarketDataRoute(capabilities)
  }

  if (params.operation === "financial_statements") {
    return {
      operation: params.operation,
      primaryProvider: capabilities.fmpConfigured ? "fmp" : "sec",
      fallbackProviders: capabilities.fmpConfigured ? ["sec"] : ["fmp"],
      financeDataOperation: "financial_statements",
      requiresCalculation: true,
      sourcePolicy: "official",
      rationale:
        "Use FMP Starter for normalized statements when configured and SEC XBRL facts as the official fallback.",
    }
  }

  if (params.operation === "filing_facts") {
    return {
      operation: params.operation,
      primaryProvider: "sec",
      fallbackProviders: [],
      financeDataOperation: "sec_company_facts",
      requiresCalculation: true,
      sourcePolicy: "official",
      rationale:
        "SEC EDGAR is the authoritative source for filings and company facts.",
    }
  }

  if (params.operation === "investment_memo_math") {
    return {
      operation: params.operation,
      primaryProvider: "local",
      fallbackProviders: [],
      requiresCalculation: true,
      sourcePolicy: "official",
      rationale:
        "Use local deterministic valuation math for DCF, scenario weighting, and investment memo verification checks.",
    }
  }

  if (params.operation === "macro_series") {
    return {
      operation: params.operation,
      primaryProvider: capabilities.fredConfigured ? "fred" : "treasury",
      fallbackProviders: capabilities.fredConfigured
        ? ["treasury", "bea", "bls", "census"]
        : ["bea", "bls", "census"],
      financeDataOperation: capabilities.fredConfigured
        ? "fred_series"
        : undefined,
      requiresCalculation: false,
      sourcePolicy: "official",
      rationale:
        "Use official macro sources first, with FRED as the normalized entry point when configured.",
    }
  }

  return {
    operation: "news_and_events",
    primaryProvider: "web_search",
    fallbackProviders: ["tavily", "finnhub", "tiingo"],
    requiresCalculation: false,
    sourcePolicy: "search",
    rationale:
      "News and event context is separated from structured finance data and should be source-backed.",
  }
}

export function getCuratedFinanceProviderOrder(
  route: CuratedFinanceRoute
): CuratedFinanceProvider[] {
  return [route.primaryProvider, ...route.fallbackProviders]
}
