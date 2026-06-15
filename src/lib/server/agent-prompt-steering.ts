import type { ModelType } from "@/lib/shared"

import {
  getLastUserMessage,
  hasPersonalFinancialAdviceIntent,
  normalizeUserText,
  type PromptTextMessage,
} from "./prompt-message-utils"

export type PromptProvider = "alibaba" | "moonshotai"

export type PromptTaskMode =
  | "general"
  | "instruction_following"
  | "closed_answer"
  | "coding"
  | "debugging"
  | "writing"
  | "research"
  | "high_stakes"

type UserExpertiseHint = "engineering" | "writing" | "research"

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
const CLOSED_ANSWER_PATTERN =
  /\b(multiple choice|choose one|which option|final answer|exact answer|boxed|answer:|confidence:|A\)|B\)|C\)|D\))\b/i
const STRICT_OUTPUT_PATTERN =
  /\b(return only|exactly|exact format|valid json|minified json|last line|single word|one word|single line|one line|two sentences|one sentence|one paragraph|no more than|under \d+ words|no surrounding prose|only one ```|schema|yaml|xml|csv)\b/i

const PROVIDER_OVERLAYS: Record<PromptProvider, string> = {
  alibaba: `
Use Qwen reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  moonshotai: `
Use Kimi reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
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

  if (model.startsWith("moonshotai/")) {
    return "moonshotai"
  }

  throw new Error(`Unsupported model provider for model: ${model}`)
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
