import type { ModelType } from "@/lib/shared"

import {
  getLastUserMessage,
  hasPersonalFinancialAdviceIntent,
  normalizeUserText,
  type PromptTextMessage,
} from "./prompt-message-utils"

export type PromptProvider = "alibaba" | "google" | "moonshotai" | "xiaomi"

export type PromptTaskMode =
  | "general"
  | "instruction_following"
  | "closed_answer"
  | "coding"
  | "debugging"
  | "writing"
  | "finance_analysis"
  | "research"
  | "high_stakes"

export type UserExpertiseHint =
  | "finance"
  | "engineering"
  | "writing"
  | "research"

type PromptSteeringMessage = PromptTextMessage

interface PromptSteeringBlock {
  label: string
  body: string
}

interface CreatePromptSteeringBlocksParams {
  provider?: PromptProvider
  taskMode?: PromptTaskMode
  providerOverlaysEnabled?: boolean
  taskModeOverlaysEnabled?: boolean
}

interface InferPromptTaskModeOptions {
  userExpertise?: UserExpertiseHint
}

// "stock up", "stocking up", and "in stock" are common non-finance idioms that
// the bare /stock/ pattern would otherwise misclassify as finance_analysis.
const FINANCE_FALSE_POSITIVE_PATTERN =
  /\b(stock(?:ing|ed)?\s+up|in\s+stock|out\s+of\s+stock|gold\s+(?:medal|standard|star)|oil\s+(?:painting|change)|bitcoin\s+(?:movie|documentary))\b/i

const CODING_PATTERN =
  /\b(code|coding|function|class|script|algorithm|typescript|javascript|python|sql|regex|unit test|implement|write a program|refactor|module|library|api endpoint|compile|build error)\b/i
// Debugging is a distinct category: triage/diagnosis work that benefits from
// extra reasoning even when no explicit code is requested.
const DEBUGGING_PATTERN =
  /\b(stack trace|traceback|error message|exception|reproduce|repro|why does .{1,40}\s(fail|crash|break|hang|throw)|not working|broken|crashes?|hangs?|deadlock|memory leak|segfault|panic|enoent|undefined is not|cannot read propert(?:y|ies)|null pointer|race condition|flaky)\b/i
const WRITING_PATTERN =
  /\b(draft|rewrite|edit|proofread|proofreading|tone|copy|copywrit|essay|blog post|newsletter|paragraph|prose|grammar|punctuation|tighten|polish|shorter version|longer version|press release|release notes?|changelog entry|cover letter|outline this|outline for)\b/i
const RESEARCH_PATTERN =
  /\b(latest|current|today|recent|as of|sources?|cite|citation|link|look up|lookup|verify|check the web|news|price right now|right now|breaking|trending|happening (?:now|today))\b/i
const HIGH_STAKES_PATTERN =
  /\b(bank|password|phish(?:ed|ing)?|security|medical|doctor|symptom|symptoms|dose|dosage|prescription|pregnant|lawsuit|legal|tax|suicid|self-harm|chest pain|emergency|infection|overdose)\b/i
// "multiple" alone is too generic ("multiple choice") so only count it when it
// follows a finance-specific qualifier.
const FINANCE_ANALYSIS_PATTERN =
  /\b(stocks?|equit(?:y|ies)|ticker|symbol|quote|quotes|company profile|finance data|financial data|finance provider|finance providers|structured finance|etf|fundamental|valuation|dcf|(?:valuation|earnings|forward|trading|p\/e|pe|ev\/ebitda)\s+multiples?|ev\/ebitda|ebitda|revenue|gross margin|operating margin|free cash flow|fcf|cash flow|income statement|balance sheet|financial statement|filing|10-k|10-q|earnings|guidance|dividend|buyback|market cap|enterprise value|treasury|yield curve|interest rate|fed funds|cpi|inflation|gdp|macro|fred|fx|foreign exchange|currency pair|commodity|commodities|oil price|crude|gold price|crypto|bitcoin|ethereum|portfolio return|sharpe|beta|drawdown)\b/i
const CLOSED_ANSWER_PATTERN =
  /\b(multiple choice|choose one|which option|final answer|exact answer|boxed|answer:|confidence:|A\)|B\)|C\)|D\))\b/i
const STRICT_OUTPUT_PATTERN =
  /\b(return only|exactly|exact format|valid json|minified json|last line|single word|one word|single line|one line|two sentences|one sentence|one paragraph|no more than|under \d+ words|no surrounding prose|only one ```|schema|yaml|xml|csv)\b/i

// Long-term memory often surfaces user-expertise tags the model has previously
// committed about the user. We extract a coarse hint here to bias borderline
// task-mode classifications.
const USER_EXPERTISE_PATTERNS: Record<UserExpertiseHint, RegExp> = {
  finance:
    /\b(finance|financial)\s+(analyst|engineer|professional|background)|\b(portfolio manager|fund manager|trader|investment banker|cfa|equity research|sell-?side|buy-?side|fp&a)\b/i,
  engineering:
    /\b(software|backend|frontend|full-?stack|systems?|platform|infrastructure|devops|sre|data)\s+engineer|\b(developer|programmer|engineer at|technical lead|cto)\b/i,
  writing:
    /\b(writer|editor|journalist|copywriter|content strategist|technical writer|author)\b/i,
  research:
    /\b(researcher|research scientist|phd candidate|academic|professor)\b/i,
}

const PROVIDER_OVERLAYS: Record<PromptProvider, string> = {
  alibaba: `
Use Qwen reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns and retrieved memory before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  google: `
Use Gemini reasoning mode efficiently.
- Spend the thinking budget on the parts of the task that are actually uncertain; do not narrate planning that adds no information.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  moonshotai: `
Use Kimi reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns and retrieved memory before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  xiaomi: `
Use MiMo reasoning mode efficiently.
- Optimize for streaming latency: start producing the user-facing answer as soon as you have a defensible thread; refine in-line.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
}

const TASK_MODE_OVERLAYS: Record<Exclude<PromptTaskMode, "general">, string> = {
  instruction_following: `
This request is parser-sensitive or format-sensitive.
- Exact compliance is mandatory.
- Return only the requested structure, wording, and delimiters.
- If a final line or key order is specified, check it literally before finishing.
- Treat word, sentence, paragraph, and line caps as hard limits. Count before finishing when close to the boundary.
- Cut any extra commentary that would reduce extractability.
`.trim(),
  closed_answer: `
This request expects one clear answer.
- Resolve ambiguity, choose the best answer, and commit.
- Keep explanation brief and keep the final answer unambiguous.
- If the task implies a required final-answer line, end with that exact line.
- If the required answer form is numeric, boxed, or one-line, return that form exactly without extra prose.
- Do not leave the answer buried in exploratory prose.
`.trim(),
  coding: `
This request is code-centric.
- Prefer runnable code and correct I/O behavior over explanation.
- If the user requests code only or one code block, obey that literally.
- Use the code_execution tool for arithmetic, spot checks, or quick validation when it reduces error risk.
- Do not add prose that would break copy-paste or grading.
`.trim(),
  debugging: `
This request is a diagnosis/debugging task.
- Form a specific hypothesis about the root cause before recommending a fix; avoid generic "try restarting" advice.
- Ask for the missing signal (exact error, repro steps, environment) only when it would materially change the diagnosis; otherwise reason from what is provided.
- When the user shares a stack trace or error, identify the originating call site and explain *why* it fails, not just *that* it fails.
- Prefer code_execution to validate the fix when arithmetic, parsing, or small reproductions can be checked locally.
- End with a concrete next action: the patch, the command to run, or the data to collect.
`.trim(),
  writing: `
This request is a writing/editing task.
- Match the requested voice, length, and audience; do not impose a default Chloei voice when the user has specified one.
- Preserve the user's factual claims and proper nouns verbatim unless asked to fact-check.
- If asked to edit, return the edited text in the requested form. If asked to rewrite, do not paste back the original.
- Length caps are hard caps; count before finishing when close to the limit.
- Skip preambles like "Sure, here is your draft" — return the deliverable.
`.trim(),
  finance_analysis: `
This request is finance-analysis work.
- Prefer structured finance tools for market data, company facts, filings, statements, historical prices, macro/rates, FX, and crypto where available.
- When the user asks what finance providers or capabilities are available, call \`finance_data\` with \`provider_status\` and answer from that status. Do not run representative data probes after a provider is reported unavailable.
- For ordinary public-company quote/profile requests, use \`finance_data\` with provider \`auto\`: quote resolves to Yahoo Finance with a Stooq fallback and company_profile resolves to SEC submissions. Do not use Tavily or web search for quote/profile while these structured fallbacks are available.
- For public-company statements, use \`finance_data\` \`financial_statements\` with provider \`auto\` and the requested \`statementType\` (\`income\`, \`balance_sheet\`, or \`cash_flow\`); this resolves to SEC company facts for US filers and Yahoo Finance for non-US companies. If margins, growth rates, free cash flow, leverage ratios, or comparisons are requested, run \`code_execution\` to verify the arithmetic.
- For 10-K/10-Q prompts asking for cash flow, capex, liabilities, debt, assets, equity, or balance-sheet items, call \`finance_data\` first instead of searching EDGAR pages. The statement result includes SEC company-facts and filing source URLs when available; cite those directly. Use search only for narrative filing excerpts or facts not present in structured data.
- For filing-specific public-company questions, use \`sec_filings\` for EDGAR company lookup, filing search, full document fetch, section extraction, table extraction, and targeted retrieval over filing text.
- Use search or extraction for market news, unsupported assets, methodology checks, or source-backed claims that structured tools do not cover.
- Use code execution for valuation math, return calculations, statement transformations, table joins, chart/statistical checks, and any arithmetic that could change the conclusion.
- Distinguish reported facts, computed values, assumptions, and interpretation.
- Do not provide personalized investment, tax, legal, or trade-execution advice. Frame analysis as informational unless the user provided an institutional workflow.
- When data is unavailable, stale, or provider-specific, say that plainly and do not fill gaps with invented figures.
- Stay on the finance task. Do not narrate unrelated wording, country-name, or language-usage considerations.
- Mirror the user's exact terminology in your final answer. If they asked about "operating margin", "CET1", "net interest income", "cash flow from operations", or "capital and exploration expenditures", use those exact phrases — do not paraphrase to synonyms a grader or screen-reader would miss.
- For multi-period comparisons ("compare X across the last N fiscal years", "show the 3-year trend"), call \`finance_data\` with \`sec_company_facts\` once — it returns the full multi-period timeseries — then compute the comparison in \`code_execution\`. Do not make N separate \`financial_statements\` calls for the same metric across N periods.
- Do not re-search the web (Tavily) for data you already have from \`sec_filings\` or \`finance_data\`. Pick one structured source per metric; web search is for narrative or non-structured context only.
- Never finish your turn with no text. After gathering evidence, you must write the synthesis: numbers, terminology, citations, and a brief takeaway. If evidence is partial or contradictory, name what you found and what is missing — silence is a worse failure than an incomplete answer.
`.trim(),
  research: `
This request needs deep research, freshness, sources, or verification.
- Clarify missing scope only when the missing detail would materially change the research plan; otherwise proceed with stated assumptions.
- Decide what claims need verification before answering, and search before answering freshness-sensitive, source-heavy, or contested claims.
- Extract or read primary pages when details, dates, numbers, methodology, or quotes matter.
- Cross-check important claims across sources, especially when sources conflict or one source is promotional.
- Use explicit calendar dates when recency matters.
- Use code execution for calculations, tabular analysis, transformations, and arithmetic checks that could change the conclusion.
- Produce a structured, citation-forward final report with clear findings, evidence, limitations, and source gaps.
- If live retrieval tools are unavailable or evidence is missing or conflicting, say that plainly instead of guessing.
`.trim(),
  high_stakes: `
This request is high-stakes.
- Optimize for correctness, concrete next actions, and low hallucination risk.
- If current or external facts matter, verify them when tools are available.
- Be direct and practical, not verbose or vague.
- In compromised-account, phishing, or financial-security scenarios, include immediate containment and stronger login protection such as 2FA/MFA when applicable.
- If something cannot be verified, say so explicitly rather than filling the gap.
`.trim(),
}

export function resolvePromptProvider(model: ModelType): PromptProvider {
  if (model.startsWith("alibaba/")) {
    return "alibaba"
  }

  if (model.startsWith("google/")) {
    return "google"
  }

  if (model.startsWith("moonshotai/")) {
    return "moonshotai"
  }

  if (model.startsWith("xiaomi/")) {
    return "xiaomi"
  }

  throw new Error(`Unsupported model provider for model: ${model}`)
}

export function inferUserExpertiseFromMemory(
  memoryContext: string | undefined | null
): UserExpertiseHint | undefined {
  if (!memoryContext) {
    return undefined
  }

  for (const [hint, pattern] of Object.entries(USER_EXPERTISE_PATTERNS) as [
    UserExpertiseHint,
    RegExp,
  ][]) {
    if (pattern.test(memoryContext)) {
      return hint
    }
  }

  return undefined
}

function detectFinanceAnalysis(text: string): boolean {
  if (!FINANCE_ANALYSIS_PATTERN.test(text)) {
    return false
  }

  return !FINANCE_FALSE_POSITIVE_PATTERN.test(text)
}

export function inferPromptTaskMode(
  messages: readonly PromptSteeringMessage[],
  options: InferPromptTaskModeOptions = {}
): PromptTaskMode {
  const lastUserMessage = getLastUserMessage(messages)
  if (!lastUserMessage) {
    return "general"
  }

  const fullUserText = normalizeUserText(messages)
  const coding = CODING_PATTERN.test(lastUserMessage)
  const debugging =
    DEBUGGING_PATTERN.test(lastUserMessage) ||
    DEBUGGING_PATTERN.test(fullUserText)
  const writing =
    WRITING_PATTERN.test(lastUserMessage) || WRITING_PATTERN.test(fullUserText)
  const strictOutput =
    STRICT_OUTPUT_PATTERN.test(lastUserMessage) ||
    STRICT_OUTPUT_PATTERN.test(fullUserText)
  const highStakes = HIGH_STAKES_PATTERN.test(lastUserMessage)
  const financialAdvice = hasPersonalFinancialAdviceIntent(lastUserMessage)
  const financeAnalysis =
    detectFinanceAnalysis(lastUserMessage) ||
    detectFinanceAnalysis(fullUserText)
  const research =
    RESEARCH_PATTERN.test(lastUserMessage) ||
    RESEARCH_PATTERN.test(fullUserText)
  const closedAnswer =
    CLOSED_ANSWER_PATTERN.test(lastUserMessage) ||
    CLOSED_ANSWER_PATTERN.test(fullUserText)

  // High-stakes always wins over expertise hints so personalization can never
  // downgrade a safety-relevant routing decision.
  if (financialAdvice) {
    return "high_stakes"
  }

  if (highStakes) {
    return "high_stakes"
  }

  if (financeAnalysis) {
    return "finance_analysis"
  }

  if (debugging) {
    return "debugging"
  }

  if (coding) {
    return "coding"
  }

  if (research) {
    return "research"
  }

  if (writing) {
    return "writing"
  }

  if (closedAnswer) {
    return "closed_answer"
  }

  if (strictOutput) {
    return "instruction_following"
  }

  // Expertise-driven fallback: a known finance analyst asking a borderline
  // question that didn't trip any pattern still routes to finance_analysis.
  if (options.userExpertise === "finance") {
    return "finance_analysis"
  }

  if (options.userExpertise === "research") {
    return "research"
  }

  if (options.userExpertise === "writing") {
    return "writing"
  }

  if (
    options.userExpertise === "engineering" &&
    lastUserMessage.includes("?")
  ) {
    return "coding"
  }

  return "general"
}

export function createPromptSteeringBlocks(
  params: CreatePromptSteeringBlocksParams
): PromptSteeringBlock[] {
  const blocks: PromptSteeringBlock[] = []

  if (params.provider && params.providerOverlaysEnabled !== false) {
    blocks.push({
      label: `PROVIDER OVERLAY: ${params.provider.toUpperCase()}`,
      body: PROVIDER_OVERLAYS[params.provider],
    })
  }

  if (
    params.taskMode &&
    params.taskMode !== "general" &&
    params.taskModeOverlaysEnabled !== false
  ) {
    blocks.push({
      label: `TASK MODE OVERLAY: ${params.taskMode.toUpperCase()}`,
      body: TASK_MODE_OVERLAYS[params.taskMode],
    })
  }

  return blocks
}
