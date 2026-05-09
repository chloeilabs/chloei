import type {
  FinancialServicesSkillId,
  FinancialServicesWorkflowId,
} from "@/lib/shared"

import type { PromptTaskMode } from "./agent-prompt-steering"

interface FinancialServicesWorkflowMessage {
  role: "user" | "assistant"
  content: string
}

interface FinancialServicesToolAvailability {
  tavilyEnabled?: boolean
  fmpEnabled?: boolean
  fredEnabled?: boolean
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

const FINANCIAL_ADVICE_PATTERN =
  /\b(should i buy|should i sell|buy or sell|personal financial advice|retirement account|401k|ira|tax return|tax filing|tax deduction|my portfolio|my savings|my mortgage|my debt)\b/i

const FINANCIAL_MODELING_PATTERN =
  /\b(dcf|discounted cash flow|lbo|leveraged buyout|three[- ]statement|3[- ]statement|trading comps?|comps analysis|precedent transactions?|valuation model|financial model|model builder|build (?:a |an )?(?:model|workbook)|create (?:a |an )?(?:model|workbook|spreadsheet)|excel valuation|workbook artifact|spreadsheet artifact|xlsx artifact|\.xlsx|football field|wacc|terminal value|sensitivity table)\b/i

const MARKET_RESEARCH_PATTERN =
  /\b(market research|sector (?:overview|primer|research)|industry (?:overview|primer|research)|theme research|competitive landscape|peer landscape|market map|company snapshot|equity research|ideas? shortlist|research this sector)\b/i

const PITCH_MATERIALS_PATTERN =
  /\b(pitch book|pitchbook|pitch deck|pitch materials?|investment banking pitch|client presentation|teaser|slide outline|valuation summary slide|strategic alternatives|situation overview)\b/i

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

function getLastUserMessage(
  messages: readonly FinancialServicesWorkflowMessage[]
): string {
  return (
    [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim())
      ?.content.trim() ?? ""
  )
}

function normalizeUserText(
  messages: readonly FinancialServicesWorkflowMessage[]
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n")
}

function inferFinancialServicesWorkflow(
  text: string
): FinancialServicesWorkflowId | null {
  if (PITCH_MATERIALS_PATTERN.test(text)) {
    return "pitch_materials"
  }

  if (FINANCIAL_MODELING_PATTERN.test(text)) {
    return "financial_modeling"
  }

  if (MARKET_RESEARCH_PATTERN.test(text)) {
    return "market_research"
  }

  return null
}

function formatAvailability(value: boolean | undefined): string {
  return value ? "configured" : "not configured"
}

function formatToolAvailability(
  tools: FinancialServicesToolAvailability | undefined
): string {
  return [
    "## Chloei Tool Mapping",
    "- Market/company data: use finance_data first.",
    "- Filings/facts: use SEC-backed finance_data when available; cite returned filing/source URLs.",
    "- Macro/rates: use FRED-backed finance_data when available.",
    "- News/source research: use Tavily or native search when structured tools do not cover the claim.",
    "- Modeling/math/artifacts: use code_execution with the finance backend.",
    "",
    "Provider signals for this request:",
    `- FMP API key: ${formatAvailability(tools?.fmpEnabled)}`,
    `- Tavily API key: ${formatAvailability(tools?.tavilyEnabled)}`,
    `- FRED API key: ${formatAvailability(tools?.fredEnabled)}`,
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
  if (!lastUserMessage || FINANCIAL_ADVICE_PATTERN.test(lastUserMessage)) {
    return null
  }

  const workflow = inferFinancialServicesWorkflow(
    `${lastUserMessage}\n\n${normalizeUserText(params.messages)}`
  )
  if (!workflow) {
    return null
  }

  const skillIds = WORKFLOW_SKILLS[workflow]
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
