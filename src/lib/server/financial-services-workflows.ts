import type {
  FinancialServicesSkillId,
  FinancialServicesWorkflowId,
} from "@/lib/shared"

import type { PromptTaskMode } from "./agent-prompt-steering"
import {
  getLastUserMessage,
  hasPersonalFinancialAdviceIntent,
  normalizeUserText,
  type PromptTextMessage,
} from "./prompt-message-utils"

type FinancialServicesWorkflowMessage = PromptTextMessage

interface FinancialServicesToolAvailability {
  tavilyEnabled?: boolean
  secUserAgentConfigured?: boolean
}

interface ResolveFinancialServicesWorkflowParams {
  messages: readonly FinancialServicesWorkflowMessage[]
  taskMode: PromptTaskMode
  tools?: FinancialServicesToolAvailability
}

export interface FinancialServicesWorkflowContext {
  workflow: FinancialServicesWorkflowId
  skillIds: FinancialServicesSkillId[]
  promptBlock: string
}

const FINANCIAL_MODELING_PATTERN =
  /\b(dcf|discounted cash flow|lbo|leveraged buyout|three[- ]statement|3[- ]statement|trading comps?|comps analysis|precedent transactions?|valuation model|financial model|model builder|excel valuation|football field|wacc|terminal value|sensitivity table)\b/i

const FINANCIAL_MODELING_CONTEXT_PATTERN =
  /\b(finance|financial|valuation|dcf|discounted cash flow|lbo|comps?|precedent transactions?|stock|stocks|ticker|market cap|capital markets|enterprise value|ev\/ebitda|ebitda|revenue|cash flow|fcf|wacc|terminal value|sensitivity|investment banking|10-k|10-q|filings?|sec (?:filings?|reports?|disclosures?|data|facts?))\b/i

const GENERIC_MODELING_ARTIFACT_PATTERN =
  /\b(?:build|create|draft|generate|make)\s+(?:a |an )?(?:model|workbook|spreadsheet)\b|\b(?:model|workbook|spreadsheet|xlsx) artifact\b|\.xlsx\b/i

const MARKET_RESEARCH_PATTERN =
  /\b(market research|sector (?:overview|primer|research)|industry (?:overview|primer|research)|theme research|competitive landscape|peer landscape|market map|company snapshot|equity research|ideas? shortlist|research this sector)\b/i

const PITCH_MATERIALS_PATTERN =
  /\b(pitch book|pitchbook|pitch deck|pitch materials?|investment banking pitch|client presentation|teaser|slide outline|valuation summary slide|strategic alternatives|situation overview)\b/i

const FILING_RESEARCH_PATTERN =
  /\b(sec (?:filings?|reports?|disclosures?|data|facts?|10-k|10-q|8-k)|edgar|10-k|10-q|8-k|annual report|quarterly report|proxy statement|def 14a|filings?|mda|md&a|management discussion|risk factors?|issuer purchases?|shares? repurchased|common stock repurchased|adjusted ebitda|non-gaap|capital raise|geographic region|segment revenue|revenue by (?:segment|region)|table extract|filing table)\b/i

const EARNINGS_REVIEW_PATTERN =
  /\b(earnings review|earnings call|earnings release|quarterly results|reported earnings|beat or miss|beat\/miss|management projections?|consensus|model update|earnings transcript|q[1-4]\s+\d{4}\s+earnings|(?:management|company|revenue|margin|eps|earnings|quarterly|annual|full-year|fy\s?\d{2,4}|q[1-4])\s+guidance|guidance\s+(?:range|midpoint|versus|vs\.?|beat|miss|raise|lower|update|revision|actuals?|compare|compared))\b/i

const WORKFLOW_SKILLS: Record<
  FinancialServicesWorkflowId,
  readonly FinancialServicesSkillId[]
> = {
  financial_modeling: [
    "model-builder",
    "dcf-model",
    "comps-analysis",
    "audit-xls",
    "xlsx-author",
  ],
  filing_research: [
    "filing-researcher",
    "sec-table-extractor",
    "evidence-auditor",
  ],
  earnings_review: [
    "earnings-reviewer",
    "filing-researcher",
    "sec-table-extractor",
    "evidence-auditor",
  ],
  market_research: ["market-researcher"],
  pitch_materials: [
    "pitch-materials",
    "market-researcher",
    "comps-analysis",
    "xlsx-author",
  ],
}

const SKILL_MARKDOWN: Record<FinancialServicesSkillId, string> = {
  "model-builder": `
## Skill: model-builder
Use this for institutional-style first-draft valuation work. Pull public company, filing, macro, and market inputs with Chloei tools; use code_execution for arithmetic, tables, charts, and workbook artifacts. Deliver analyst work product for human review, not final investment advice.

Workflow:
- Confirm the target, model type, currency/units, period basis, and missing assumptions when needed.
- Prefer structured finance_data for company facts, statements, prices, profiles, and macro/rates.
- Build outputs from sourced inputs and explicit assumptions. Distinguish reported facts, computed figures, and assumptions.
- For workbook deliverables, use xlsx-author and audit-xls conventions before listing artifacts.
`.trim(),
  "dcf-model": `
## Skill: dcf-model
Use this for DCF or intrinsic-value work. Build projections, WACC, terminal value, present value, equity bridge, and sensitivity tables from sourced inputs and explicit assumptions.

Rules:
- Use live spreadsheet formulas for projection, margin, discounting, terminal value, bridge, and sensitivity cells.
- Hardcodes are allowed only for raw reported inputs, sourced market data, and explicit assumptions.
- Source every material input. If an input is unavailable, mark it as an assumption or data gap.
- Use code_execution to check valuation math and, when asked, generate a workbook artifact.
`.trim(),
  "comps-analysis": `
## Skill: comps-analysis
Use this for trading comps, precedent transactions, peer screening, multiples, and valuation ranges.

Rules:
- Define the peer set and why each peer is included or excluded.
- Keep metric definitions consistent across companies. Flag outliers and stale or missing data.
- Prefer finance_data for public company facts and market data, then search/extract for unsupported narrative or transaction context.
- Summarize min, median, mean where useful, but do not invent unavailable multiples.
`.trim(),
  "audit-xls": `
## Skill: audit-xls
Use this before presenting any spreadsheet artifact.

Conventions:
- Blue cells are hardcoded inputs, black cells are formulas, and green cells are links to other tabs or files.
- Calculation cells must not contain typed output values.
- Include a checks area for balance checks, formula sanity checks, and key source/assumption flags.
- If code_execution returns an artifactManifest, mention the relevant artifact names and sizes in the final answer. Use artifact URLs only when the manifest includes them.
`.trim(),
  "xlsx-author": `
## Skill: xlsx-author
Use this when producing a headless Excel workbook or chart image through code_execution.

Rules:
- Write relative artifact filenames directly, such as model.xlsx, comps.xlsx, dcf_model.xlsx, or valuation_chart.png.
- Do not create scratch or probe files; every generated file can appear in the artifact manifest.
- Return artifact names and sizes from the artifactManifest in the final answer.
- If an artifactManifest item includes a URL, format the artifact as a markdown link. If it has no URL, list only the artifact name and size.
`.trim(),
  "filing-researcher": `
## Skill: filing-researcher
Use this for public-company SEC/EDGAR research and Finance Agent benchmark-style filing questions.

Rules:
- Use sec_filings for company lookup, filing search, document fetch, section extraction, table extraction, and targeted retrieval over filing text.
- Prefer full filing evidence over search snippets. Cite SEC filing URLs returned by the tool.
- Identify the exact company, ticker or CIK, form type, filing date, report period, and section/table used.
- For extracted values, preserve units, signs, dates, and period labels exactly before calculating.
`.trim(),
  "earnings-reviewer": `
## Skill: earnings-reviewer
Use this for quarterly earnings, guidance versus actuals, beat/miss analysis, earnings updates, and filing-backed model refreshes.

Rules:
- Pull the relevant 10-Q, 10-K, 8-K, earnings release, and filing sections before answering.
- Reconcile management guidance, actual reported values, and period dates before calculating beat/miss or trend metrics.
- Use code_execution for percentage changes, CAGRs, margin bridges, and sequential or year-over-year comparisons.
- Separate reported figures, computed values, and interpretation.
`.trim(),
  "evidence-auditor": `
## Skill: evidence-auditor
Use this before finalizing public-markets finance answers.

Checklist:
- Every material numeric claim ties to a tool result, SEC filing source, or explicit assumption.
- Calculations that affect the answer were checked with code_execution.
- The final answer names the filing period and source dates when recency or period matching matters.
- If evidence is incomplete, stale, or ambiguous, state the limitation directly instead of filling the gap.
`.trim(),
  "sec-table-extractor": `
## Skill: sec-table-extractor
Use this for SEC filing tables such as repurchases, segment revenue, guidance, reconciliation tables, debt schedules, and non-GAAP bridges.

Rules:
- Use sec_filings table_extract with the most specific heading or query available.
- Keep row labels, column labels, units, and fiscal period labels attached to extracted numbers.
- When a table spans multiple rows or columns, reconstruct the relevant slice before calculating.
- Do not infer missing table values from surrounding narrative unless the source explicitly states them.
`.trim(),
  "market-researcher": `
## Skill: market-researcher
Use this for company, sector, theme, and competitive research.

Rules:
- Use current sources for recent facts, market conditions, news, and competitive claims.
- Prefer primary sources such as filings, company releases, regulator pages, and investor materials when available.
- Separate facts, sourced interpretation, and Chloei's analysis.
- Cite sources inline for material factual claims and dates.
`.trim(),
  "pitch-materials": `
## Skill: pitch-materials
Use this for review-ready first drafts of pitch narratives, valuation summaries, and slide outlines.

Rules:
- Produce draft materials for banker or analyst review only.
- No external communications, client outreach, trade execution, or final professional advice.
- Start with situation overview, company snapshot, market context, valuation summary, risks, and suggested next diligence.
- Generate real PPTX only if the user explicitly asks and Chloei has a supported artifact path; otherwise provide a cited slide outline or narrative.
`.trim(),
}

function inferFinancialServicesWorkflow(
  text: string,
  taskMode: PromptTaskMode
): FinancialServicesWorkflowId | null {
  if (PITCH_MATERIALS_PATTERN.test(text)) {
    return "pitch_materials"
  }

  if (EARNINGS_REVIEW_PATTERN.test(text)) {
    return "earnings_review"
  }

  const hasGenericModelingArtifact =
    GENERIC_MODELING_ARTIFACT_PATTERN.test(text)
  const hasFinancialModelingContext =
    taskMode === "finance_analysis" ||
    FINANCIAL_MODELING_CONTEXT_PATTERN.test(text)

  if (
    FINANCIAL_MODELING_PATTERN.test(text) ||
    (hasGenericModelingArtifact && hasFinancialModelingContext)
  ) {
    return "financial_modeling"
  }

  if (FILING_RESEARCH_PATTERN.test(text)) {
    return "filing_research"
  }

  if (MARKET_RESEARCH_PATTERN.test(text)) {
    return "market_research"
  }

  return null
}

function formatAvailability(value: boolean | undefined): string {
  return value ? "configured" : "not configured"
}

function isSecFilingRetrievalAvailable(
  tools: FinancialServicesToolAvailability | undefined
): boolean {
  return tools?.secUserAgentConfigured === true
}

function getWorkflowSkillIds(
  workflow: FinancialServicesWorkflowId,
  tools: FinancialServicesToolAvailability | undefined
): readonly FinancialServicesSkillId[] {
  if (isSecFilingRetrievalAvailable(tools)) {
    return WORKFLOW_SKILLS[workflow]
  }

  if (workflow === "earnings_review") {
    return ["earnings-reviewer", "evidence-auditor"]
  }

  return WORKFLOW_SKILLS[workflow]
}

function formatToolAvailability(
  tools: FinancialServicesToolAvailability | undefined
): string {
  const filingRetrievalGuidance = isSecFilingRetrievalAvailable(tools)
    ? "- Filing retrieval: use sec_filings for EDGAR filing search, full-document fetches, sections, tables, and targeted retrieval."
    : "- Filing retrieval: dedicated EDGAR retrieval is unavailable without a configured SEC user agent; use finance_data SEC facts or web search where available, and state filing-retrieval limitations clearly."

  return [
    "## Chloei Tool Mapping",
    "- Market/company data: use finance_data first.",
    "- Filings/facts: use SEC-backed finance_data when available; cite returned filing/source URLs.",
    filingRetrievalGuidance,
    "- News/source research: use Tavily search when structured tools do not cover the claim.",
    "- Modeling/math/artifacts: use code_execution with the finance backend.",
    "",
    "Provider signals for this request:",
    `- Tavily API key: ${formatAvailability(tools?.tavilyEnabled)}`,
    `- SEC user agent: ${formatAvailability(tools?.secUserAgentConfigured)}`,
  ].join("\n")
}

function buildPromptBlock(params: {
  workflow: FinancialServicesWorkflowId
  skillIds: readonly FinancialServicesSkillId[]
  tools?: FinancialServicesToolAvailability
}): string {
  return [
    "# Chloei Financial Services Workflow",
    "",
    `Selected workflow: ${params.workflow}`,
    "",
    "Use this workflow only for the current finance-services task. Higher-priority operating, safety, user, and runtime instructions still govern the response.",
    "",
    "## Guardrails",
    "- Treat outputs as review-oriented analyst work product.",
    "- Do not provide personalized investment, tax, legal, accounting, or trade-execution advice.",
    "- Do not claim access to premium connectors such as CapIQ, Daloopa, FactSet, Morningstar, PitchBook, or LSEG unless a Chloei tool exposes them in this run.",
    "- Cite material sourced claims and show assumptions separately from reported facts.",
    "- If data is unavailable or stale, say so directly instead of filling gaps with invented figures.",
    "",
    formatToolAvailability(params.tools),
    "",
    "## Selected Skills",
    ...params.skillIds.map((skillId) => SKILL_MARKDOWN[skillId]),
  ].join("\n")
}

export function resolveFinancialServicesWorkflow(
  params: ResolveFinancialServicesWorkflowParams
): FinancialServicesWorkflowContext | null {
  if (params.taskMode === "high_stakes") {
    return null
  }

  const lastUserMessage = getLastUserMessage(params.messages)
  if (!lastUserMessage || hasPersonalFinancialAdviceIntent(lastUserMessage)) {
    return null
  }

  let workflow = inferFinancialServicesWorkflow(
    `${lastUserMessage}\n\n${normalizeUserText(params.messages)}`,
    params.taskMode
  )
  if (!workflow) {
    return null
  }

  if (
    workflow === "filing_research" &&
    !isSecFilingRetrievalAvailable(params.tools)
  ) {
    workflow = "market_research"
  }

  const skillIds = getWorkflowSkillIds(workflow, params.tools)
  return {
    workflow,
    skillIds: [...skillIds],
    promptBlock: buildPromptBlock({
      workflow,
      skillIds,
      tools: params.tools,
    }),
  }
}
