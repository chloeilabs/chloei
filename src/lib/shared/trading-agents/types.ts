/**
 * Shared types for the Trading Desk feature.
 *
 * These mirror the event vocabulary emitted by the TradingAgents sidecar
 * service (see `tradingagents-service/app/events.py`). The service streams SSE;
 * the Chloei `/api/trading-desk/analyze` route re-emits each event as one NDJSON
 * line, which the client parses with `parseTradingDeskEventLine`.
 */

export const TRADING_DESK_ANALYST_KEYS = [
  "market",
  "social",
  "news",
  "fundamentals",
] as const
type TradingDeskAnalystKey = (typeof TRADING_DESK_ANALYST_KEYS)[number]

export const TRADING_DESK_DEPTHS = ["shallow", "medium", "deep"] as const
export type TradingDeskDepth = (typeof TRADING_DESK_DEPTHS)[number]

/** Five-tier decision scale, ordered most-bullish to most-bearish. */
export const TRADING_DESK_SIGNALS = [
  "Buy",
  "Overweight",
  "Hold",
  "Underweight",
  "Sell",
] as const
type TradingDeskSignal = (typeof TRADING_DESK_SIGNALS)[number]

export type TradingDeskAgentStatus = "pending" | "in_progress" | "completed"

interface TradingDeskAgent {
  key: string
  name: string
  selectable: boolean
}

export interface TradingDeskTeam {
  id: string
  label: string
  agents: TradingDeskAgent[]
}

/**
 * Static fallback roster mirroring the service's `roster.py`. Used to render
 * the pipeline immediately; the authoritative roster arrives in `run_started`.
 */
export const TRADING_DESK_DEFAULT_TEAMS: TradingDeskTeam[] = [
  {
    id: "analysts",
    label: "Analyst Team",
    agents: [
      { key: "market", name: "Market Analyst", selectable: true },
      { key: "social", name: "Sentiment Analyst", selectable: true },
      { key: "news", name: "News Analyst", selectable: true },
      { key: "fundamentals", name: "Fundamentals Analyst", selectable: true },
    ],
  },
  {
    id: "research",
    label: "Research Team",
    agents: [
      { key: "bull", name: "Bull Researcher", selectable: false },
      { key: "bear", name: "Bear Researcher", selectable: false },
      { key: "research_manager", name: "Research Manager", selectable: false },
    ],
  },
  {
    id: "trading",
    label: "Trading Team",
    agents: [{ key: "trader", name: "Trader", selectable: false }],
  },
  {
    id: "risk",
    label: "Risk Management",
    agents: [
      { key: "aggressive", name: "Aggressive Analyst", selectable: false },
      { key: "conservative", name: "Conservative Analyst", selectable: false },
      { key: "neutral", name: "Neutral Analyst", selectable: false },
    ],
  },
  {
    id: "portfolio",
    label: "Portfolio Management",
    agents: [
      {
        key: "portfolio_manager",
        name: "Portfolio Manager",
        selectable: false,
      },
    ],
  },
]

export interface TradingDeskRequest {
  ticker: string
  tradeDate?: string | null
  analysts: TradingDeskAnalystKey[]
  depth: TradingDeskDepth
  assetType?: "stock" | "crypto"
  /** Reserved; no effect in TradingAgents 0.2.5 (data is sourced via the
   *  framework's `data_vendors`, defaulting to live yfinance). Kept for
   *  backward compatibility with the request schema. */
  online?: boolean
  mock?: boolean | null
}

export interface TradingDeskConfig {
  teams: TradingDeskTeam[]
  analysts: TradingDeskAnalystKey[]
  depths: {
    id: TradingDeskDepth
    label: string
    max_debate_rounds: number
    max_risk_discuss_rounds: number
  }[]
  default_depth: TradingDeskDepth
  signals: TradingDeskSignal[]
  defaults: {
    provider: string
    deep_think_llm: string
    quick_think_llm: string
  }
  llm_ready: boolean
  mock_default: boolean
}

interface TradingDeskReport {
  market_report: string
  sentiment_report: string
  news_report: string
  fundamentals_report: string
  investment_plan: string
  trader_investment_plan: string
  final_trade_decision: string
}

export interface TradingDeskDebates {
  research: { bull: string; bear: string; judge: string }
  risk: {
    aggressive: string
    conservative: string
    neutral: string
    judge: string
  }
}

export interface TradingDeskStats {
  llm_calls: number
  tool_calls: number
  tokens_in: number
  tokens_out: number
  elapsed_seconds?: number
}

// --- Streamed events (discriminated by `type`) ------------------------------

interface TaRunStartedEvent {
  type: "run_started"
  run_id: string
  ticker: string
  trade_date: string
  asset_type: string
  analysts: string[]
  teams: TradingDeskTeam[]
  llm: {
    provider: string
    deep_think_llm: string
    quick_think_llm: string
    backend_url: string | null
  }
  mock: boolean
}

interface TaAgentStatusEvent {
  type: "agent_status"
  agent: string
  status: TradingDeskAgentStatus
  team: string
  team_label: string
}

interface TaReportSectionEvent {
  type: "report_section"
  section: string
  title: string
  team: string
  content: string
}

interface TaDebateUpdateEvent {
  type: "debate_update"
  debate: "research" | "risk"
  role: string
  content: string
}

interface TaToolCallEvent {
  type: "tool_call"
  tool: string
  args: unknown
  agent: string | null
}

interface TaActivityEvent {
  type: "activity"
  kind: string
  content: string
  agent: string | null
}

interface TaStatsEvent extends TradingDeskStats {
  type: "stats"
}

export interface TaRunCompletedEvent {
  type: "run_completed"
  decision: string
  signal: string
  report: TradingDeskReport
  debates: TradingDeskDebates
  stats: TradingDeskStats
  elapsed_seconds: number
}

interface TaErrorEvent {
  type: "error"
  message: string
  where?: string | null
}

interface TaDoneEvent {
  type: "done"
}

export type TradingDeskEvent =
  | TaRunStartedEvent
  | TaAgentStatusEvent
  | TaReportSectionEvent
  | TaDebateUpdateEvent
  | TaToolCallEvent
  | TaActivityEvent
  | TaStatsEvent
  | TaRunCompletedEvent
  | TaErrorEvent
  | TaDoneEvent

const TRADING_DESK_EVENT_TYPES = new Set<TradingDeskEvent["type"]>([
  "run_started",
  "agent_status",
  "report_section",
  "debate_update",
  "tool_call",
  "activity",
  "stats",
  "run_completed",
  "error",
  "done",
])

/** Parse a single NDJSON line into a typed event, or null if unrecognised. */
export function parseTradingDeskEventLine(
  line: string
): TradingDeskEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return null
  }
  const type = (parsed as { type: string }).type
  if (!TRADING_DESK_EVENT_TYPES.has(type as TradingDeskEvent["type"])) {
    return null
  }
  return parsed as TradingDeskEvent
}

/** Bucket a signal into a directional tone for badge/colour rendering. */
export function tradingDeskSignalTone(
  signal: string
): "bullish" | "bearish" | "neutral" {
  const normalized = signal.trim().toLowerCase()
  if (normalized === "buy" || normalized === "overweight") {
    return "bullish"
  }
  if (normalized === "sell" || normalized === "underweight") {
    return "bearish"
  }
  return "neutral"
}
