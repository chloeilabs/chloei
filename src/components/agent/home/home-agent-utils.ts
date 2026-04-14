import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import type { Message as AgentMessage, ModelType } from "@/lib/shared"

export const EMPTY_ASSISTANT_RESPONSE_FALLBACK =
  ASSISTANT_EMPTY_RESPONSE_FALLBACK

interface AgentRequestMessage {
  role: "user" | "assistant"
  content: string
}

export function createClientMessageId() {
  return globalThis.crypto.randomUUID()
}

export function toRequestMessages(
  messages: AgentMessage[]
): AgentRequestMessage[] {
  return messages
    .filter(
      (
        message
      ): message is AgentMessage & {
        role: "user" | "assistant"
      } => message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0)
}

export function appendUserMessage(
  currentMessages: AgentMessage[],
  content: string,
  model: ModelType
): AgentMessage[] {
  const userMessage: AgentMessage = {
    id: createClientMessageId(),
    role: "user",
    content,
    llmModel: model,
    createdAt: new Date().toISOString(),
    metadata: {
      isStreaming: false,
      selectedModel: model,
    },
  }

  const lastMessage = currentMessages[currentMessages.length - 1]
  const shouldReplaceLastUnansweredMessage =
    lastMessage?.role === "user" && lastMessage.content.trim() === content

  const baseMessages = shouldReplaceLastUnansweredMessage
    ? currentMessages.slice(0, -1)
    : currentMessages

  return [...baseMessages, userMessage]
}
