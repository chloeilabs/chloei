import { tool } from "ai"
import { z } from "zod"

import { asRecord } from "@/lib/cast"
import type { ToolName } from "@/lib/shared"

import { runFinanceDataOperation } from "./ai-sdk-finance-data-tools"
import {
  addEvidence,
  createEvidenceLedger,
  type EvidenceKind,
} from "./evidence-ledger"
import {
  type CuratedFinanceOperation,
  getCuratedFinanceProviderOrder,
  routeCuratedFinanceRequest,
} from "./finance-tool-router"

const CURATED_FINANCE_TOOL_NAME = "curated_finance" as const

type CuratedFinanceToolName = Extract<
  ToolName,
  typeof CURATED_FINANCE_TOOL_NAME
>

interface CuratedFinanceToolCallMetadata {
  callId: string
  toolName: CuratedFinanceToolName
  label: string
  operation?: string
  provider?: string
}

interface CuratedFinanceToolResultMetadata {
  callId: string
  toolName: CuratedFinanceToolName
  status: "success" | "error"
  sources: []
  operation?: string
  provider?: string
  errorCode?: string
  retryable?: boolean
}

interface CuratedFinanceToolConfig {
  fmpApiKey?: string
  fredApiKey?: string
  secUserAgent?: string
  fetchImpl?: typeof fetch
}

const curatedFinanceInputSchema = z.object({
  operation: z.enum([
    "resolve_security",
    "company_snapshot",
    "market_data",
    "financial_statements",
    "filing_facts",
    "macro_series",
    "news_and_events",
  ]),
  symbol: z.string().trim().min(1).max(40).optional(),
  cik: z.string().trim().min(1).max(20).optional(),
  query: z.string().trim().min(1).max(500).optional(),
  seriesId: z.string().trim().min(1).max(80).optional(),
  statementType: z.enum(["income", "balance_sheet", "cash_flow"]).optional(),
  period: z.enum(["annual", "quarter"]).optional(),
  from: z.string().trim().min(1).max(20).optional(),
  to: z.string().trim().min(1).max(20).optional(),
})

type CuratedFinanceInput = z.infer<typeof curatedFinanceInputSchema>

function getEvidenceKind(operation: CuratedFinanceOperation): EvidenceKind {
  if (operation === "macro_series") {
    return "macro"
  }
  if (operation === "filing_facts" || operation === "financial_statements") {
    return "filing"
  }
  if (operation === "news_and_events") {
    return "news"
  }
  return "market_data"
}

function getLabel(operation: string | undefined): string {
  if (operation === "company_snapshot") return "Curated finance: company"
  if (operation === "filing_facts") return "Curated finance: filings"
  if (operation === "financial_statements") return "Curated finance: statements"
  if (operation === "macro_series") return "Curated finance: macro"
  if (operation === "market_data") return "Curated finance: market data"
  if (operation === "resolve_security") return "Curated finance: identifiers"
  if (operation === "news_and_events") return "Curated finance: events"
  return "Curated finance"
}

function toFinanceDataInput(input: CuratedFinanceInput) {
  if (input.operation === "resolve_security") {
    return {
      operation: "symbol_search" as const,
      provider: "auto" as const,
      query: input.query ?? input.symbol,
    }
  }

  if (input.operation === "company_snapshot") {
    return {
      operation: "company_profile" as const,
      provider: "auto" as const,
      symbol: input.symbol,
      cik: input.cik,
    }
  }

  if (input.operation === "market_data") {
    return {
      operation: input.from || input.to ? "historical_prices" : "quote",
      provider: "auto" as const,
      symbol: input.symbol,
      from: input.from,
      to: input.to,
    } as const
  }

  if (input.operation === "financial_statements") {
    return {
      operation: "financial_statements" as const,
      provider: "auto" as const,
      symbol: input.symbol,
      statementType: input.statementType ?? "income",
      period: input.period ?? "annual",
    }
  }

  if (input.operation === "filing_facts") {
    return {
      operation: "sec_company_facts" as const,
      provider: "sec" as const,
      cik: input.cik,
    }
  }

  if (input.operation === "macro_series") {
    return {
      operation: "fred_series" as const,
      provider: "fred" as const,
      seriesId: input.seriesId,
      from: input.from,
      to: input.to,
    }
  }

  return null
}

export function createAiSdkCuratedFinanceTools(
  config: CuratedFinanceToolConfig = {}
) {
  return {
    curated_finance: tool({
      description:
        "Run a high-level curated finance operation with provider routing, FMP-first behavior, official-source fallbacks, and an evidence ledger. Use this before raw provider tools for finance analysis, investment memos, macro research, filings, market data, and identifier resolution. For stock attractiveness work, collect current market data and SEC-backed reported facts before valuation. Buy-side memos should reconcile primary-source facts, separate company quality from stock attractiveness, and support reverse-DCF or scenario valuation math with operating drivers.",
      inputSchema: curatedFinanceInputSchema,
      execute: async (input) => {
        const route = routeCuratedFinanceRequest({
          operation: input.operation,
          capabilities: {
            fmpConfigured: Boolean(config.fmpApiKey?.trim()),
            fredConfigured: Boolean(config.fredApiKey?.trim()),
          },
        })

        if (input.operation === "news_and_events") {
          return {
            route,
            providerOrder: getCuratedFinanceProviderOrder(route),
            error: {
              code: "USE_SEARCH_TOOL",
              message:
                "News and events require web_search, Tavily, Finnhub, or Tiingo. Use source-backed search rather than structured finance data.",
              retryable: false,
            },
          }
        }

        const financeDataInput = toFinanceDataInput(input)
        if (!financeDataInput) {
          return {
            route,
            providerOrder: getCuratedFinanceProviderOrder(route),
            error: {
              code: "UNSUPPORTED_CURATED_OPERATION",
              message: "This curated finance operation is not implemented yet.",
              retryable: false,
            },
          }
        }

        const result = await runFinanceDataOperation(financeDataInput, config)
        let ledger = createEvidenceLedger()
        const output = result.output
        if (output) {
          ledger = addEvidence(ledger, {
            kind: getEvidenceKind(input.operation),
            provider: output.provider,
            operation: output.operation,
            title: getLabel(input.operation),
            summary: `Curated finance route used ${output.provider} for ${output.operation}.`,
            confidence: output.sources.length > 0 ? "high" : "medium",
            source: output.sources[0],
            reportedValues: asRecord(output.data) ?? undefined,
          })
        }

        return {
          route,
          providerOrder: getCuratedFinanceProviderOrder(route),
          financeDataInput,
          result,
          ledger,
        }
      },
    }),
  }
}

export function isAiSdkCuratedFinanceToolName(
  value: unknown
): value is CuratedFinanceToolName {
  return value === CURATED_FINANCE_TOOL_NAME
}

export function getAiSdkCuratedFinanceToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): CuratedFinanceToolCallMetadata | null {
  if (part?.toolName !== CURATED_FINANCE_TOOL_NAME) {
    return null
  }

  const input = asRecord(part.input)
  const operation =
    typeof input?.operation === "string" ? input.operation : undefined

  return {
    callId: part.toolCallId,
    toolName: CURATED_FINANCE_TOOL_NAME,
    label: getLabel(operation),
    ...(operation ? { operation } : {}),
    provider: "curated",
  }
}

export function getAiSdkCuratedFinanceToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): CuratedFinanceToolResultMetadata | null {
  if (part?.toolName !== CURATED_FINANCE_TOOL_NAME) {
    return null
  }

  const output = asRecord(part.output)
  const result = asRecord(output?.result)
  const error = asRecord(output?.error) ?? asRecord(result?.error)
  const route = asRecord(output?.route)
  const operation =
    typeof route?.operation === "string" ? route.operation : undefined
  const primaryProvider =
    typeof route?.primaryProvider === "string" ? route.primaryProvider : undefined

  return {
    callId: part.toolCallId,
    toolName: CURATED_FINANCE_TOOL_NAME,
    status: error ? "error" : "success",
    sources: [],
    ...(operation ? { operation } : {}),
    ...(primaryProvider ? { provider: primaryProvider } : {}),
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(typeof error?.retryable === "boolean"
      ? { retryable: error.retryable }
      : { retryable: false }),
  }
}
