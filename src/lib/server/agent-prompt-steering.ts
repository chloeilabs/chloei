import type { ModelType } from "@/lib/shared"

import {
  createPromptSteeringBlocks as createSystemPromptSteeringBlocks,
  type PromptBlock,
  type PromptProvider,
  type PromptTaskMode,
} from "./llm/system-prompts"

export type { PromptProvider, PromptTaskMode } from "./llm/system-prompts"

interface PromptSteeringMessage {
  role: "user" | "assistant"
  content: string
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
const CLOSED_ANSWER_PATTERN =
  /\b(multiple choice|choose one|which option|final answer|exact answer|boxed|answer:|confidence:|A\)|B\)|C\)|D\))\b/i
const STRICT_OUTPUT_PATTERN =
  /\b(return only|exactly|exact format|valid json|minified json|last line|single word|one word|single line|one line|two sentences|one sentence|one paragraph|no more than|under \d+ words|no surrounding prose|only one ```|schema|yaml|xml|csv)\b/i

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
): PromptBlock[] {
  return createSystemPromptSteeringBlocks(params)
}
