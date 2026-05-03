import { tool } from "ai"
import { z } from "zod"

import { asRecord } from "@/lib/cast"
import type { ToolName } from "@/lib/shared"

import { runFinanceDataOperation } from "./ai-sdk-finance-data-tools"
import {
  addEvidence,
  createEvidenceLedger,
  type EvidenceKind,
  verifyInvestmentMemoRequirements,
} from "./evidence-ledger"
import {
  type CuratedFinanceOperation,
  getCuratedFinanceProviderOrder,
  routeCuratedFinanceRequest,
} from "./finance-tool-router"
import {
  calculateDcfScenario,
  calculateProbabilityWeightedExpectedValue,
} from "./investment-memo-math"

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

const curatedFinanceInputSchema = z
  .object({
    operation: z.enum([
      "resolve_security",
      "company_snapshot",
      "market_data",
      "financial_statements",
      "filing_facts",
      "investment_memo_math",
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
    dcf: z
      .object({
        startingFcf: z.number(),
        fcfCagr: z.number(),
        years: z.number().int().min(1).max(50),
        wacc: z.number().positive(),
        terminalGrowth: z.number(),
        netCash: z.number().optional(),
        dilutedShares: z.number().positive().optional(),
      })
      .optional(),
    scenarios: z
      .array(
        z.object({
          probability: z.number().min(0).max(1),
          price: z.number(),
        })
      )
      .min(1)
      .max(20)
      .optional(),
    memoChecks: z
      .object({
        hasPrimarySourceCapexRebuild: z.boolean().optional(),
        hasDcfSensitivityMatrix: z.boolean().optional(),
        hasCodeVerifiedDcfMath: z.boolean().optional(),
        hasProbabilityWeightedExpectedValue: z.boolean().optional(),
        hasChinaExportSizing: z.boolean().optional(),
        labelsEstimatedCustomerExposure: z.boolean().optional(),
        softensUnverifiedAiChipClaims: z.boolean().optional(),
        rejectsUnsupportedSecondaryCatalysts: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const addRequiredIssue = (path: string[], message: string) => {
      context.addIssue({
        code: "custom",
        message,
        path,
      })
    }

    if (
      value.operation === "resolve_security" &&
      !value.query &&
      !value.symbol
    ) {
      addRequiredIssue(
        ["query"],
        '"query" or "symbol" is required for operation "resolve_security".'
      )
    }

    if (value.operation === "company_snapshot" && !value.symbol && !value.cik) {
      addRequiredIssue(
        ["symbol"],
        '"symbol" or "cik" is required for operation "company_snapshot".'
      )
    }

    if (
      (value.operation === "market_data" ||
        value.operation === "financial_statements") &&
      !value.symbol
    ) {
      addRequiredIssue(
        ["symbol"],
        `"symbol" is required for operation "${value.operation}".`
      )
    }

    if (value.operation === "filing_facts" && !value.cik) {
      addRequiredIssue(
        ["cik"],
        '"cik" is required for operation "filing_facts".'
      )
    }

    if (value.operation === "macro_series" && !value.seriesId) {
      addRequiredIssue(
        ["seriesId"],
        '"seriesId" is required for operation "macro_series".'
      )
    }

    if (
      value.operation === "investment_memo_math" &&
      !value.dcf &&
      !value.scenarios &&
      !value.memoChecks
    ) {
      addRequiredIssue(
        ["dcf"],
        '"dcf", "scenarios", or "memoChecks" is required for operation "investment_memo_math".'
      )
    }
  })

type CuratedFinanceInput = z.infer<typeof curatedFinanceInputSchema>

function getEvidenceKind(operation: CuratedFinanceOperation): EvidenceKind {
  if (operation === "investment_memo_math") {
    return "calculation"
  }
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
  if (operation === "investment_memo_math") return "Curated finance: memo math"
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

function runInvestmentMemoMath(input: CuratedFinanceInput) {
  const startedAt = Date.now()
  const dcf = input.dcf ? calculateDcfScenario(input.dcf) : undefined
  const expectedValue = input.scenarios
    ? calculateProbabilityWeightedExpectedValue(input.scenarios)
    : undefined
  const verification = input.memoChecks
    ? verifyInvestmentMemoRequirements(input.memoChecks)
    : undefined
  const data = {
    ...(dcf ? { dcf } : {}),
    ...(expectedValue !== undefined ? { expectedValue } : {}),
    ...(verification ? { verification } : {}),
  }
  const result = {
    output: {
      operation: "investment_memo_math" as const,
      provider: "local" as const,
      data,
      sources: [],
      durationMs: Date.now() - startedAt,
      attempts: 1,
    },
  }
  const ledger = addEvidence(createEvidenceLedger(), {
    kind: "calculation",
    provider: "local",
    operation: "investment_memo_math",
    title: getLabel(input.operation),
    summary:
      "Computed deterministic investment memo valuation math and verification checks.",
    confidence: "high",
    computedValues: data,
    limitations: verification?.gaps,
  })

  return { result, ledger }
}

function getErrorRetryable(error: unknown): boolean {
  const retryable = asRecord(error)?.retryable
  return typeof retryable === "boolean" ? retryable : true
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

        if (input.operation === "investment_memo_math") {
          try {
            const { result, ledger } = runInvestmentMemoMath(input)
            return {
              route,
              providerOrder: getCuratedFinanceProviderOrder(route),
              result,
              ledger,
            }
          } catch (error) {
            return {
              route,
              providerOrder: getCuratedFinanceProviderOrder(route),
              error: {
                code: "INVESTMENT_MEMO_MATH_ERROR",
                message:
                  error instanceof Error
                    ? error.message
                    : "Investment memo math failed.",
                retryable: false,
              },
              ledger: createEvidenceLedger(),
            }
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

        try {
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
        } catch (error) {
          return {
            route,
            providerOrder: getCuratedFinanceProviderOrder(route),
            financeDataInput,
            error: {
              code: "FINANCE_DATA_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Curated finance data failed.",
              retryable: getErrorRetryable(error),
            },
            ledger: createEvidenceLedger(),
          }
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
    typeof route?.primaryProvider === "string"
      ? route.primaryProvider
      : undefined

  return {
    callId: part.toolCallId,
    toolName: CURATED_FINANCE_TOOL_NAME,
    status: error ? "error" : "success",
    sources: [],
    ...(operation ? { operation } : {}),
    ...(primaryProvider ? { provider: primaryProvider } : {}),
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(error
      ? {
          retryable:
            typeof error.retryable === "boolean" ? error.retryable : false,
        }
      : {}),
  }
}
