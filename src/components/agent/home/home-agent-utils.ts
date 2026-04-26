import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import type {
  AgentRunMode,
  Message as AgentMessage,
  ModelType,
} from "@/lib/shared"
import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

export const EMPTY_ASSISTANT_RESPONSE_FALLBACK =
  ASSISTANT_EMPTY_RESPONSE_FALLBACK
export const CLIENT_MESSAGE_MAX_CHARS = AGENT_REQUEST_MAX_MESSAGE_CHARS
const TRUNCATED_MESSAGE_SUFFIX =
  "\n\n[Earlier content truncated to fit this agent request.]"

interface AgentRequestMessage {
  role: "user" | "assistant"
  content: string
}

export function createClientMessageId() {
  return globalThis.crypto.randomUUID()
}

function getTotalContentLength(messages: AgentRequestMessage[]) {
  return messages.reduce((total, message) => total + message.content.length, 0)
}

function trimMessageContent(content: string): string {
  if (content.length <= AGENT_REQUEST_MAX_MESSAGE_CHARS) {
    return content
  }

  const contentLimit = Math.max(
    0,
    AGENT_REQUEST_MAX_MESSAGE_CHARS - TRUNCATED_MESSAGE_SUFFIX.length
  )

  return `${content.slice(0, contentLimit).trimEnd()}${TRUNCATED_MESSAGE_SUFFIX}`
}

export function toRequestMessages(
  messages: AgentMessage[]
): AgentRequestMessage[] {
  const requestMessages = messages
    .filter(
      (
        message
      ): message is AgentMessage & {
        role: "user" | "assistant"
      } => message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: trimMessageContent(message.content.trim()),
    }))
    .filter((message) => message.content.length > 0)

  const boundedMessages = requestMessages.slice(-AGENT_REQUEST_MAX_MESSAGES)

  while (
    boundedMessages.length > 1 &&
    getTotalContentLength(boundedMessages) > AGENT_REQUEST_MAX_TOTAL_CHARS
  ) {
    boundedMessages.shift()
  }

  return boundedMessages
}

export function appendUserMessage(
  currentMessages: AgentMessage[],
  content: string,
  model: ModelType,
  runMode: AgentRunMode = "chat"
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
      runMode,
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
