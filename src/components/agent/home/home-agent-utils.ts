import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import {
  type AgentAttachmentMetadata,
  type AgentRequestAttachment,
  type AgentRunMode,
  type Message as AgentMessage,
  type ModelType,
  toAgentAttachmentMetadata,
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
  attachments?: AgentRequestAttachment[]
}

interface ToRequestMessagesOptions {
  attachmentsByMessageId?: ReadonlyMap<string, AgentRequestAttachment[]>
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
  messages: AgentMessage[],
  options: ToRequestMessagesOptions = {}
): AgentRequestMessage[] {
  const requestMessages = messages
    .filter(
      (
        message
      ): message is AgentMessage & {
        role: "user" | "assistant"
      } => message.role === "user" || message.role === "assistant"
    )
    .map((message) => {
      const attachments =
        message.role === "user"
          ? (options.attachmentsByMessageId?.get(message.id) ?? [])
          : []

      return {
        role: message.role,
        content: trimMessageContent(message.content.trim()),
        ...(attachments.length > 0 ? { attachments } : {}),
      }
    })
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
  runMode: AgentRunMode = "chat",
  attachments: readonly (AgentAttachmentMetadata | AgentRequestAttachment)[] = []
): AgentMessage[] {
  const attachmentMetadata = attachments.map((attachment) =>
    "dataUrl" in attachment
      ? toAgentAttachmentMetadata(attachment)
      : attachment
  )
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
      ...(attachmentMetadata.length > 0
        ? { attachments: attachmentMetadata }
        : {}),
    },
  }

  const lastMessage = currentMessages[currentMessages.length - 1]
  const shouldReplaceLastUnansweredMessage =
    lastMessage?.role === "user" &&
    lastMessage.content.trim() === content &&
    attachmentMetadata.length === 0 &&
    (lastMessage.metadata?.attachments?.length ?? 0) === 0

  const baseMessages = shouldReplaceLastUnansweredMessage
    ? currentMessages.slice(0, -1)
    : currentMessages

  return [...baseMessages, userMessage]
}

export function hasUserMessageAttachments(messages: AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" && (message.metadata?.attachments?.length ?? 0) > 0
  )
}
