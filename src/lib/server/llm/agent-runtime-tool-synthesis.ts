import type { ModelMessage } from "ai"

const SOURCE_BACKED_PROMPT_PATTERN =
  /\b(current|latest|search|web|source|sources|citation|citations|cite|link|links|documentation|release)\b/i
const EXTERNAL_SOURCE_NEGATION_PATTERN =
  /\b(?:do not|don't|without|no)\s+(?:use\s+)?(?:external\s+)?(?:sources?|web|search|citations?|links?)\b/i
const FACT_COUNT_PATTERN =
  /\b(?:three|3)\b[\s\w-]*(?:facts?|points?|items?|updates?)\b/i
const MIN_SOURCE_BACKED_ANSWER_CHARS = 900

function getLastUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") {
      continue
    }

    if (typeof message.content === "string") {
      return message.content
    }

    return message.content
      .flatMap((part) =>
        part.type === "text" && typeof part.text === "string" ? [part.text] : []
      )
      .join("\n")
  }

  return ""
}

export function getSourceBackedPromptQuery(
  model: string,
  messages: readonly ModelMessage[]
): string | null {
  if (!model.startsWith("xai/")) {
    return null
  }

  const lastUserText = getLastUserText(messages).trim()
  if (EXTERNAL_SOURCE_NEGATION_PATTERN.test(lastUserText)) {
    return null
  }

  return SOURCE_BACKED_PROMPT_PATTERN.test(lastUserText) ? lastUserText : null
}

export function shouldForceToolSynthesisStep(params: {
  model: string
  messages: readonly ModelMessage[]
  textCharCount: number
  sourceCount: number
  steps: readonly { toolResults?: readonly unknown[] }[]
  toolResultStatuses: ReadonlyMap<string, "success" | "error">
}): boolean {
  const toolOutputCount = params.toolResultStatuses.size
  if (
    !params.model.startsWith("xai/") ||
    toolOutputCount === 0 ||
    [...params.toolResultStatuses.values()].some((status) => status === "error")
  ) {
    return false
  }

  const lastStep = params.steps.at(-1)
  if (!lastStep || (lastStep.toolResults?.length ?? 0) === 0) {
    return false
  }

  const lastUserText = getLastUserText(params.messages)
  if (!SOURCE_BACKED_PROMPT_PATTERN.test(lastUserText)) {
    return false
  }

  if (params.textCharCount === 0) {
    return true
  }

  if (
    params.sourceCount > 0 &&
    params.textCharCount < MIN_SOURCE_BACKED_ANSWER_CHARS
  ) {
    return true
  }

  return (
    FACT_COUNT_PATTERN.test(lastUserText) &&
    params.textCharCount < MIN_SOURCE_BACKED_ANSWER_CHARS
  )
}

export function buildToolSynthesisPrompt(systemInstruction: string): string {
  return [
    systemInstruction,
    "",
    "The previous xAI tool-backed answer may be partial.",
    "Continue and complete the final answer now using the existing tool results and sources already present in the conversation.",
    "Do not call tools.",
    "If the user requested source links or citations, include source-backed references in the final answer.",
    "Do not repeat completed material; continue from the missing details when possible.",
  ].join("\n")
}

export const XAI_TOOL_SYNTHESIS_INSTRUCTION = [
  "The previous xAI tool-backed answer may be partial.",
  "Continue and complete the final answer now using the existing tool results and sources already present in the conversation.",
  "Do not call tools.",
  "If the user requested source links or citations, include source-backed references in the final answer.",
  "Do not repeat completed material; continue from the missing details when possible.",
].join(" ")
