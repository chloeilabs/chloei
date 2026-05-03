import type { ModelType } from "@/lib/shared"

import type { AgentInputMessage } from "./agent-runtime-messages"
import { createEvidenceLedger, type EvidenceLedger } from "./evidence-ledger"

export type AgentHarnessProfileId =
  | "chat_default"
  | "deep_research"
  | "earnings_research"
  | "finance_analysis"
  | "investment_memo"
  | "macro_research"

export type AgentHarnessRiskLevel = "low" | "medium" | "high"
export type AgentHarnessTraceStage =
  | "evidence"
  | "final_synthesis"
  | "plan"
  | "tool_decision"
  | "verification"

export interface AgentHarnessBudgets {
  maxSearchCalls: number
  maxToolCalls: number
  maxVerificationChecks: number
  codeExecutionTimeoutMs: number
}

export interface AgentPlan {
  objective: string
  profile: AgentHarnessProfileId
  riskLevel: AgentHarnessRiskLevel
  requiredEvidence: string[]
  candidateTools: string[]
  stopConditions: string[]
}

export interface AgentToolDecision {
  toolName: string
  reason: string
  expectedOutput: string
  retryLimit: number
}

export interface AgentHarnessRun {
  requestId?: string
  model: ModelType
  profile: AgentHarnessProfileId
  userTimeZone?: string
  messageSummary: string
  budgets: AgentHarnessBudgets
  plan: AgentPlan
  evidenceLedger: EvidenceLedger
  toolDecisions: AgentToolDecision[]
  errors: string[]
  status: "planned" | "running" | "completed" | "failed"
}

export interface AgentHarnessTraceEvent {
  type: "harness_trace"
  stage: AgentHarnessTraceStage
  label: string
  detail?: string
  status?: "info" | "success" | "warning" | "error"
}

const DEFAULT_BUDGETS: Record<AgentHarnessProfileId, AgentHarnessBudgets> = {
  chat_default: {
    maxSearchCalls: 2,
    maxToolCalls: 6,
    maxVerificationChecks: 1,
    codeExecutionTimeoutMs: 10_000,
  },
  deep_research: {
    maxSearchCalls: 8,
    maxToolCalls: 20,
    maxVerificationChecks: 5,
    codeExecutionTimeoutMs: 30_000,
  },
  finance_analysis: {
    maxSearchCalls: 4,
    maxToolCalls: 14,
    maxVerificationChecks: 4,
    codeExecutionTimeoutMs: 60_000,
  },
  investment_memo: {
    maxSearchCalls: 6,
    maxToolCalls: 24,
    maxVerificationChecks: 8,
    codeExecutionTimeoutMs: 60_000,
  },
  earnings_research: {
    maxSearchCalls: 6,
    maxToolCalls: 18,
    maxVerificationChecks: 4,
    codeExecutionTimeoutMs: 45_000,
  },
  macro_research: {
    maxSearchCalls: 4,
    maxToolCalls: 16,
    maxVerificationChecks: 5,
    codeExecutionTimeoutMs: 45_000,
  },
}

function getLastUserMessage(messages: readonly AgentInputMessage[]): string {
  return (
    [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim())
      ?.content.trim() ?? ""
  )
}

function inferHarnessProfile(text: string): AgentHarnessProfileId {
  if (/\b(earnings|transcript|guidance|surprise|estimate)\b/i.test(text)) {
    return "earnings_research"
  }
  if (/\b(memo|investment thesis|valuation|dcf|catalyst|moat)\b/i.test(text)) {
    return "investment_memo"
  }
  if (
    /\b(fed|fred|macro|inflation|cpi|gdp|treasury|yield|interest rates?|fed funds rate|policy rates?)\b/i.test(
      text
    )
  ) {
    return "macro_research"
  }
  if (
    /\b(stock|ticker|filing|10-k|10-q|financial statements?|market cap|fcf|ebitda)\b/i.test(
      text
    )
  ) {
    return "finance_analysis"
  }
  if (/\b(research|source|sources|latest|current|news|verify)\b/i.test(text)) {
    return "deep_research"
  }
  return "chat_default"
}

function isSpecializedFinanceProfile(profile: AgentHarnessProfileId): boolean {
  return (
    profile === "investment_memo" ||
    profile === "earnings_research" ||
    profile === "macro_research" ||
    profile === "finance_analysis"
  )
}

export function resolveAgentHarnessProfile(
  text: string,
  profileHint?: AgentHarnessProfileId
): AgentHarnessProfileId {
  const inferredProfile = inferHarnessProfile(text)

  if (!profileHint || profileHint === "chat_default") {
    return inferredProfile
  }

  if (profileHint === "finance_analysis") {
    return isSpecializedFinanceProfile(inferredProfile)
      ? inferredProfile
      : "finance_analysis"
  }

  if (profileHint === "deep_research") {
    return isSpecializedFinanceProfile(inferredProfile)
      ? inferredProfile
      : "deep_research"
  }

  return profileHint
}

function inferRiskLevel(text: string): AgentHarnessRiskLevel {
  if (
    /\b(should i buy|should i sell|tax|legal|retirement|portfolio)\b/i.test(
      text
    )
  ) {
    return "high"
  }
  if (
    /\b(current|latest|valuation|forecast|estimate|macro|filing)\b/i.test(text)
  ) {
    return "medium"
  }
  return "low"
}

function removeCodeExecutionForTextToolModels(
  model: ModelType,
  tools: string[]
): string[] {
  if (model.startsWith("deepseek/") || model.startsWith("moonshotai/")) {
    return tools.filter((tool) => tool !== "code_execution")
  }
  return tools
}

function getCandidateTools(
  profile: AgentHarnessProfileId,
  model: ModelType
): string[] {
  if (profile === "macro_research") {
    return removeCodeExecutionForTextToolModels(model, [
      "curated_finance",
      "finance_data",
      "web_search",
      "code_execution",
    ])
  }
  if (profile === "deep_research") {
    return ["web_search", "tavily_search", "tavily_extract", "curated_finance"]
  }
  if (
    profile === "finance_analysis" ||
    profile === "investment_memo" ||
    profile === "earnings_research"
  ) {
    return removeCodeExecutionForTextToolModels(model, [
      "curated_finance",
      "finance_data",
      "fmp_mcp",
      "web_search",
      "code_execution",
    ])
  }
  return removeCodeExecutionForTextToolModels(model, [
    "web_search",
    "code_execution",
  ])
}

function getRequiredEvidence(profile: AgentHarnessProfileId): string[] {
  if (profile === "macro_research") {
    return ["official macro series", "data vintage", "source URL"]
  }
  if (profile === "investment_memo") {
    return [
      "current market data with as-of source",
      "SEC reported facts",
      "GAAP vs non-GAAP EPS and share-count reconciliation",
      "financial statements",
      "reverse DCF or scenario valuation math",
      "operating-driver bull/base/bear model",
      "hyperscaler AI capex dependency",
      "primary-source hyperscaler capex rebuild",
      "customer concentration and ASIC substitution analysis",
      "China/export-control risk sizing",
      "DCF sensitivity matrix",
      "code-verified DCF math",
      "probability-weighted expected value",
      "bear/base/bull downside analysis",
      "buy/hold/sell zones by investor type",
      "falsification triggers",
      "source-quality audit",
    ]
  }
  if (profile === "earnings_research") {
    return ["earnings dates", "news or transcript evidence", "price context"]
  }
  if (profile === "finance_analysis") {
    return ["structured finance data", "source URL", "calculation checks"]
  }
  if (profile === "deep_research") {
    return ["current sources", "cross-checks", "limitations"]
  }
  return ["only evidence needed for correctness"]
}

function getProfileChecklist(profile: AgentHarnessProfileId): string[] {
  if (profile !== "investment_memo") {
    return []
  }

  return [
    "Use primary sources first: company filings/releases, earnings-call transcripts, hyperscaler filings/capex guidance, official export-control documents, and official/industry TAM sources.",
    "Reconcile GAAP EPS, non-GAAP EPS, diluted share count, SBC, buybacks, segment revenue, customer concentration, and cash/securities directly from NVIDIA filings or releases before using secondary data.",
    "Separate company quality from stock attractiveness with explicit answers to: Is it a great business? Is it a great stock at this price? What is priced in? What would make it a buy? What would make it a sell?",
    "Build bear/base/bull operating cases from drivers: Data Center revenue CAGR, Gaming CAGR, networking growth, gross margin, operating margin, FCF margin, terminal multiple, share count, and margin fade.",
    "Include valuation sensitivity, not just a single reverse DCF: test FCF margin, WACC, terminal growth or terminal multiple, FCF CAGR, and share count.",
    "Verify DCF scenario math with code execution when available. If code execution is unavailable, say the DCF is manually computed and include enough formula detail for audit.",
    "Rebuild hyperscaler AI capex from primary sources for Microsoft, Amazon, Google, and Meta before relying on compiled third-party estimates; use Oracle, Tesla/xAI, sovereign AI, and others as additional buyers only when sourced.",
    "Quantify AI capex dependency across major buyers when evidence is available; distinguish training, inference, networking, replacement cycles, customer ROI, and whether capex is accelerating or digesting.",
    "Analyze customer concentration using direct-customer disclosures and end-customer exposure; discuss hyperscaler bargaining power and internal ASIC substitution risk.",
    "Size China/export-control risk: historical China contribution, restricted products, compliant-chip margin/revenue tradeoffs, domestic substitution, and whether the risk appears priced in.",
    "Keep technicals and positioning secondary: 52-week high/low, moving averages, options/IV, short interest, insider selling, and ownership changes are timing inputs, not thesis proof.",
    "End with a recommendation framework by investor type, buy/hold/trim zones, catalyst calendar, and falsification tests.",
    "When scenario probabilities and prices are provided, compute the probability-weighted expected value and compare it with the current price.",
    "Replace promotional moat language with precise competitive analysis across AMD GPUs, Google TPU, AWS Trainium, Microsoft Maia, Broadcom/Marvell ASICs, startup accelerators, and software abstraction risk.",
    "Do not include weak macro-color catalysts or over-specific AI-chip claims unless primary sources support the exact wording; for Amazon/Anthropic Trainium claims, distinguish infrastructure commitments from proof that a named model was trained on a specific chip.",
  ]
}

export function createAgentHarnessRun(params: {
  requestId?: string
  model: ModelType
  messages: readonly AgentInputMessage[]
  profile?: AgentHarnessProfileId
  profileHint?: AgentHarnessProfileId
  userTimeZone?: string
}): AgentHarnessRun {
  const lastUserMessage = getLastUserMessage(params.messages)
  const profile =
    params.profile ??
    resolveAgentHarnessProfile(lastUserMessage, params.profileHint)
  const riskLevel = inferRiskLevel(lastUserMessage)
  const plan: AgentPlan = {
    objective: lastUserMessage || "Respond to the user's request.",
    profile,
    riskLevel,
    requiredEvidence: getRequiredEvidence(profile),
    candidateTools: getCandidateTools(profile, params.model),
    stopConditions: [
      "answer is sufficiently supported",
      "tool budget is exhausted",
      "important evidence is unavailable and disclosed",
    ],
  }

  return {
    requestId: params.requestId,
    model: params.model,
    profile,
    userTimeZone: params.userTimeZone,
    messageSummary: lastUserMessage.slice(0, 500),
    budgets: DEFAULT_BUDGETS[profile],
    plan,
    evidenceLedger: createEvidenceLedger(),
    toolDecisions: [],
    errors: [],
    status: "planned",
  }
}

export function createHarnessTraceEvents(
  run: AgentHarnessRun
): AgentHarnessTraceEvent[] {
  return [
    {
      type: "harness_trace",
      stage: "plan",
      label: `Harness profile: ${run.profile}`,
      detail: run.plan.requiredEvidence.join(", "),
      status: "info",
    },
    {
      type: "harness_trace",
      stage: "tool_decision",
      label: "Candidate tools selected",
      detail: run.plan.candidateTools.join(", "),
      status: "info",
    },
  ]
}

export function getHarnessPromptContext(run: AgentHarnessRun): string {
  return [
    "# Agent Harness Plan",
    "",
    `- Profile: ${run.profile}`,
    `- Risk level: ${run.plan.riskLevel}`,
    `- Objective: ${run.plan.objective}`,
    `- Required evidence: ${run.plan.requiredEvidence.join(", ")}`,
    `- Candidate tools: ${run.plan.candidateTools.join(", ")}`,
    `- Max tool calls: ${String(run.budgets.maxToolCalls)}`,
    `- Max verification checks: ${String(run.budgets.maxVerificationChecks)}`,
    ...(getProfileChecklist(run.profile).length
      ? [
          "",
          "## Institutional Memo Checklist",
          ...getProfileChecklist(run.profile).map((item) => `- ${item}`),
        ]
      : []),
    "",
    "Use this harness plan as routing guidance. Prefer the curated finance tool for finance workflows because it applies provider selection and evidence tracking before exposing results.",
    "For stock attractiveness or investment-memo work, verify current market data, reported SEC facts, and valuation math before final synthesis. Do not present a bullish or bearish conclusion until reverse-DCF or scenario math has been checked with code execution.",
  ].join("\n")
}
