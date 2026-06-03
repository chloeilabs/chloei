import { tool } from "ai"
import { z } from "zod"

import { asRecord } from "@/lib/cast"
import {
  fetchTradingDeskResult,
  TradingAgentsServiceError,
} from "@/lib/server/trading-agents/client"
import { TRADINGAGENTS_ENABLED } from "@/lib/server/trading-agents/config"
import type { MessageSource, ToolName } from "@/lib/shared"
import {
  TRADING_DESK_ANALYST_KEYS,
  TRADING_DESK_DEPTHS,
} from "@/lib/shared/trading-agents/types"

const TRADING_ANALYSIS_TOOL_NAME = "trading_analysis" as const
type TradingAnalysisToolName = Extract<
  ToolName,
  typeof TRADING_ANALYSIS_TOOL_NAME
>

const MAX_DECISION_CHARS = 1500
const MAX_SECTION_CHARS = 600

const inputSchema = z.object({
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(15)
    .describe("Stock ticker symbol, e.g. NVDA or AAPL."),
  depth: z
    .enum(TRADING_DESK_DEPTHS)
    .optional()
    .describe("Research depth. Defaults to 'shallow' (fastest)."),
  analysts: z
    .array(z.enum(TRADING_DESK_ANALYST_KEYS))
    .optional()
    .describe("Subset of analysts to run. Defaults to all four."),
})

function clamp(text: string | undefined, max: number): string {
  const value = (text ?? "").trim()
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max).trimEnd()}…`
}

interface TradingAnalysisToolCallMetadata {
  callId: string
  toolName: TradingAnalysisToolName
  label: string
  query?: string
  attempt: number
}

interface TradingAnalysisToolResultMetadata {
  callId: string
  toolName: TradingAnalysisToolName
  status: "success" | "error"
  sources: MessageSource[]
}

/**
 * A chat-agent tool that runs the full TradingAgents multi-agent desk for a
 * ticker and returns a compact decision summary inline. The heavy work runs in
 * the Python sidecar; this just aggregates its final result. Gated by
 * `TRADINGAGENTS_ENABLED` — returns no tools when the feature is off.
 */
export function createAiSdkTradingAgentsTools(
  config: { enabled?: boolean } = {}
) {
  const enabled = config.enabled ?? TRADINGAGENTS_ENABLED
  if (!enabled) {
    return {}
  }
  return {
    [TRADING_ANALYSIS_TOOL_NAME]: tool({
      description:
        "Run a multi-agent trading-desk analysis for a single stock ticker: market, sentiment, news, and fundamentals analysts, a bull-vs-bear research debate, a trader, and a risk committee produce a Buy / Overweight / Hold / Underweight / Sell decision with rationale. Use for questions like 'should I buy NVDA', 'analyze AAPL', or 'what's the trade on TSLA'. Takes 1–3 minutes. For broad market data or quotes use finance_data instead.",
      inputSchema,
      execute: async (input, options) => {
        try {
          const result = await fetchTradingDeskResult(
            {
              ticker: input.ticker.toUpperCase(),
              depth: input.depth ?? "shallow",
              analysts:
                input.analysts && input.analysts.length > 0
                  ? input.analysts
                  : [...TRADING_DESK_ANALYST_KEYS],
              assetType: "stock",
              online: true,
              mock: null,
            },
            options.abortSignal
          )
          return {
            ticker: input.ticker.toUpperCase(),
            signal: result.signal,
            decision: clamp(
              result.debates.risk.judge || result.decision,
              MAX_DECISION_CHARS
            ),
            reports: {
              market: clamp(result.report.market_report, MAX_SECTION_CHARS),
              sentiment: clamp(
                result.report.sentiment_report,
                MAX_SECTION_CHARS
              ),
              news: clamp(result.report.news_report, MAX_SECTION_CHARS),
              fundamentals: clamp(
                result.report.fundamentals_report,
                MAX_SECTION_CHARS
              ),
              trading_plan: clamp(
                result.report.trader_investment_plan,
                MAX_SECTION_CHARS
              ),
            },
            stats: result.stats,
          }
        } catch (error) {
          const message =
            error instanceof TradingAgentsServiceError
              ? error.message
              : error instanceof Error
                ? error.message
                : "The trading analysis failed."
          return { error: message, ticker: input.ticker.toUpperCase() }
        }
      },
    }),
  }
}

export function isAiSdkTradingAgentsToolName(
  value: unknown
): value is TradingAnalysisToolName {
  return value === TRADING_ANALYSIS_TOOL_NAME
}

export function getAiSdkTradingAgentsToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): TradingAnalysisToolCallMetadata | null {
  if (part?.toolName !== TRADING_ANALYSIS_TOOL_NAME) {
    return null
  }
  const ticker = asRecord(part.input)?.ticker
  const tickerText = typeof ticker === "string" ? ticker.toUpperCase() : ""
  return {
    callId: part.toolCallId,
    toolName: TRADING_ANALYSIS_TOOL_NAME,
    label: tickerText ? `Trading desk · ${tickerText}` : "Trading desk",
    ...(tickerText ? { query: tickerText } : {}),
    attempt: 1,
  }
}

export function getAiSdkTradingAgentsToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): TradingAnalysisToolResultMetadata | null {
  if (part?.toolName !== TRADING_ANALYSIS_TOOL_NAME) {
    return null
  }
  const output = asRecord(part.output)
  const status = output && "error" in output ? "error" : "success"
  return {
    callId: part.toolCallId,
    toolName: TRADING_ANALYSIS_TOOL_NAME,
    status,
    sources: [],
  }
}
