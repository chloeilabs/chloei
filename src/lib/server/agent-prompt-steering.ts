import type { ModelType } from "@/lib/shared"

export type PromptProvider =
  | "anthropic"
  | "deepseek"
  | "moonshotai"
  | "openai"
  | "xai"

export type PromptTaskMode =
  | "general"
  | "instruction_following"
  | "closed_answer"
  | "coding"
  | "finance_analysis"
  | "math_data"
  | "research"
  | "high_stakes"

interface PromptSteeringMessage {
  role: "user" | "assistant"
  content: string
}

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

const CODING_PATTERN =
  /\b(code|coding|function|class|script|algorithm|typescript|javascript|python|sql|regex|unit test|debug|bug fix|implement|write a program)\b/i
const RESEARCH_PATTERN =
  /\b(latest|current|today|recent|as of|source|sources|cite|citation|link|look up|lookup|verify|check the web|news|price right now|right now)\b/i
const HIGH_STAKES_PATTERN =
  /\b(bank|password|phishing|security|medical|doctor|symptom|symptoms|dose|dosage|prescription|pregnant|lawsuit|legal|tax|suicid|self-harm|chest pain|emergency|infection)\b/i
const FINANCE_ANALYSIS_PATTERN =
  /\b(stock|stocks|equity|equities|ticker|symbol|quote|quotes|company profile|finance data|financial data|finance provider|finance providers|structured finance|etf|fundamental|valuation|dcf|multiple|ev\/ebitda|ebitda|revenue|gross margin|operating margin|free cash flow|fcf|cash flow|income statement|balance sheet|financial statement|filing|10-k|10-q|earnings|guidance|dividend|buyback|market cap|enterprise value|treasury|yield curve|interest rate|fed funds|cpi|inflation|gdp|macro|fred|fx|foreign exchange|currency pair|commodity|commodities|oil|gold|crypto|bitcoin|ethereum|portfolio return|sharpe|beta|drawdown)\b/i
const FINANCIAL_ADVICE_PATTERN =
  /\b(should i buy|should i sell|buy or sell|personal financial advice|retirement account|401k|ira|tax return|tax filing|tax deduction|my portfolio|my savings|my mortgage|my debt)\b/i
const MATH_DATA_PATTERN =
  /\b(calculate|compute|solve|equation|system of equations|integral|derivative|probability|statistics|regression|correlation|standard deviation|variance|matrix|linear algebra|optimize|optimization|simulate|simulation|monte carlo|dataset|dataframe|csv|spreadsheet|table|chart|plot|join tables|transform data)\b/i
const CLOSED_ANSWER_PATTERN =
  /\b(multiple choice|choose one|which option|final answer|exact answer|boxed|answer:|confidence:|A\)|B\)|C\)|D\))\b/i
const STRICT_OUTPUT_PATTERN =
  /\b(return only|exactly|exact format|valid json|minified json|last line|single word|one word|single line|one line|two sentences|one sentence|one paragraph|no more than|under \d+ words|no surrounding prose|only one ```|schema|yaml|xml|csv)\b/i

const PROVIDER_OVERLAYS: Record<PromptProvider, string> = {
  anthropic: `
Use Claude reasoning mode efficiently.
- Keep the final answer tighter than the hidden reasoning.
- Prefer adaptive thinking over unnecessary verbosity.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- Use native web search or other tools only when they materially improve accuracy or freshness.
- After tool use, synthesize and stop. Do not replay raw tool output.
`.trim(),
  deepseek: `
Use DeepSeek reasoning mode efficiently.
- Keep the final answer concise and grounded in the actual task.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  moonshotai: `
Use Kimi reasoning mode efficiently.
- Keep the final answer concise and grounded in the actual task.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  openai: `
Use OpenAI reasoning mode efficiently.
- Keep the final answer tighter than the hidden reasoning.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  xai: `
Use Grok reasoning mode efficiently.
- Keep the final answer concise and grounded in the actual task.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- For tool-backed current-events, news, or research answers, write the complete final response in one pass. Do not stop after the first section, source, or example.
- Keep hidden search planning and tool-use narration out of the final answer.
- Do not include meta commentary such as "the user asked", "the task is", "I think", confidence macros, or notes about instructions.
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
  finance_analysis: `
This request is finance-analysis work.
- Prefer structured finance tools for market data, company facts, filings, statements, historical prices, macro/rates, FX, and crypto where available.
- When the user asks what finance providers or capabilities are available, call \`finance_data\` with \`provider_status\` and answer from that status. Do not run representative data probes after a provider is reported unavailable.
- For ordinary public-company quote/profile requests, use \`finance_data\` with provider \`auto\`: quote resolves to the structured Stooq quote fallback and company_profile resolves to SEC submissions when FMP is unavailable. Do not use Tavily or web search for quote/profile while these structured fallbacks are available.
- For public-company statements, use \`finance_data\` \`financial_statements\` with provider \`auto\` and the requested \`statementType\` (\`income\`, \`balance_sheet\`, or \`cash_flow\`); when FMP is unavailable this resolves to SEC company facts. If margins, growth rates, free cash flow, leverage ratios, or comparisons are requested, run \`code_execution\` to verify the arithmetic.
- For 10-K/10-Q prompts asking for cash flow, capex, liabilities, debt, assets, equity, or balance-sheet items, call \`finance_data\` first instead of searching EDGAR pages. The statement result includes SEC company-facts and filing source URLs when available; cite those directly. Use search only for narrative filing excerpts or facts not present in structured data.
- Use search or extraction for market news, unsupported assets, methodology checks, or source-backed claims that structured tools do not cover.
- Use code execution for valuation math, return calculations, statement transformations, table joins, chart/statistical checks, and any arithmetic that could change the conclusion.
- Distinguish reported facts, computed values, assumptions, and interpretation.
- Do not provide personalized investment, tax, legal, or trade-execution advice. Frame analysis as informational unless the user provided an institutional workflow.
- When data is unavailable, stale, or provider-specific, say that plainly and do not fill gaps with invented figures.
- Stay on the finance task. Do not narrate unrelated wording, country-name, or language-usage considerations.
`.trim(),
  math_data: `
This request needs deterministic math, data analysis, or computation.
- Use code execution for arithmetic, algebra checks, simulations, statistics, table transformations, chart data, and any calculation that could change the answer.
- State assumptions, formulas, and units when they affect the result.
- Prefer exact values when possible; otherwise include sensible precision and avoid false certainty.
- For data tasks, distinguish raw inputs, transformations, computed outputs, and interpretation.
- If a computation cannot be run or the data is insufficient, say that plainly instead of guessing.
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

const XAI_FINANCE_ANALYSIS_OVERLAY = `
This request is finance-analysis work.
- Use structured finance evidence supplied in the prompt when present; that evidence was retrieved before the model response.
- Cite the evidence sources when the user asks for sources or current market facts.
- If quote, profile, filing, statement, market-cap, or macro data is absent or stale, say that plainly instead of filling gaps with invented figures.
- Distinguish reported facts, computed values, assumptions, and interpretation.
- Return only the user-facing answer. Do not include prompt analysis, planning text, confidence macros, or notes about internal instructions.
- Do not provide personalized investment, tax, legal, or trade-execution advice. Frame analysis as informational unless the user provided an institutional workflow.
- Stay on the finance task and complete the answer in one pass.
`.trim()

function normalizeUserText(messages: readonly PromptSteeringMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n")
}

function getLastUserMessage(
  messages: readonly PromptSteeringMessage[]
): string | null {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim())

  return lastUserMessage?.content.trim() ?? null
}

export function resolvePromptProvider(model: ModelType): PromptProvider {
  if (model.startsWith("anthropic/")) {
    return "anthropic"
  }

  if (model.startsWith("openai/")) {
    return "openai"
  }

  if (model.startsWith("deepseek/")) {
    return "deepseek"
  }

  if (model.startsWith("moonshotai/")) {
    return "moonshotai"
  }

  if (model.startsWith("xai/")) {
    return "xai"
  }

  throw new Error(`Unsupported model provider for model: ${model}`)
}

export function inferPromptTaskMode(
  messages: readonly PromptSteeringMessage[]
): PromptTaskMode {
  const lastUserMessage = getLastUserMessage(messages)
  if (!lastUserMessage) {
    return "general"
  }

  const fullUserText = normalizeUserText(messages)
  const coding = CODING_PATTERN.test(lastUserMessage)
  const strictOutput =
    STRICT_OUTPUT_PATTERN.test(lastUserMessage) ||
    STRICT_OUTPUT_PATTERN.test(fullUserText)
  const highStakes = HIGH_STAKES_PATTERN.test(lastUserMessage)
  const financialAdvice = FINANCIAL_ADVICE_PATTERN.test(lastUserMessage)
  const financeAnalysis =
    FINANCE_ANALYSIS_PATTERN.test(lastUserMessage) ||
    FINANCE_ANALYSIS_PATTERN.test(fullUserText)
  const mathData =
    MATH_DATA_PATTERN.test(lastUserMessage) ||
    MATH_DATA_PATTERN.test(fullUserText)
  const research =
    RESEARCH_PATTERN.test(lastUserMessage) ||
    RESEARCH_PATTERN.test(fullUserText)
  const closedAnswer =
    CLOSED_ANSWER_PATTERN.test(lastUserMessage) ||
    CLOSED_ANSWER_PATTERN.test(fullUserText)

  if (financeAnalysis && !financialAdvice) {
    return "finance_analysis"
  }

  if (financialAdvice) {
    return "high_stakes"
  }

  if (highStakes) {
    return "high_stakes"
  }

  if (mathData) {
    return "math_data"
  }

  if (coding) {
    return "coding"
  }

  if (research) {
    return "research"
  }

  if (closedAnswer) {
    return "closed_answer"
  }

  if (strictOutput) {
    return "instruction_following"
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
      body:
        params.provider === "xai" && params.taskMode === "finance_analysis"
          ? XAI_FINANCE_ANALYSIS_OVERLAY
          : TASK_MODE_OVERLAYS[params.taskMode],
    })
  }

  return blocks
}
