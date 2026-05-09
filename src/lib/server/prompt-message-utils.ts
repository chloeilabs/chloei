export interface PromptTextMessage {
  role: "user" | "assistant"
  content: string
}

const PERSONAL_FINANCIAL_ADVICE_PATTERN =
  /\b(should i buy|should i sell|buy or sell|personal financial advice|retirement account|401k|ira|tax return|tax filing|tax deduction|my portfolio|my savings|my mortgage|my debt)\b/i

export function hasPersonalFinancialAdviceIntent(text: string): boolean {
  return PERSONAL_FINANCIAL_ADVICE_PATTERN.test(text)
}

export function getLastUserMessage(
  messages: readonly PromptTextMessage[]
): string | null {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim())

  return lastUserMessage?.content.trim() ?? null
}

export function normalizeUserText(
  messages: readonly PromptTextMessage[]
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n")
}
