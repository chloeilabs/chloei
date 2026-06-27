import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import { createRequestHeaders } from "@/lib/request-id"
import {
  type Message as AgentMessage,
  type MessageAttachment,
  type ModelType,
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

interface AgentRequestAttachment {
  id: string
  kind: MessageAttachment["kind"]
  name: string
  mediaType: string
  url: string
}

interface AgentRequestMessage {
  role: "user" | "assistant"
  content: string
  attachments?: AgentRequestAttachment[]
}

interface AgentRequestMessageDraft {
  id: string
  role: "user" | "assistant"
  content: string
  attachments?: AgentRequestAttachment[]
}

function getClientTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone.trim()
    return timeZone || undefined
  } catch {
    return undefined
  }
}

export function createAgentRequestHeaders(): HeadersInit {
  const timeZone = getClientTimeZone()

  return createRequestHeaders({
    "Content-Type": "application/json",
    ...(timeZone ? { "X-User-Timezone": timeZone } : {}),
  })
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
  const requestMessageDrafts: AgentRequestMessageDraft[] = messages
    .filter(
      (
        message
      ): message is AgentMessage & {
        role: "user" | "assistant"
      } => message.role === "user" || message.role === "assistant"
    )
    .map((message) => {
      const attachments = (message.metadata?.attachments ?? [])
        .filter(
          (attachment): attachment is MessageAttachment & { url: string } =>
            typeof attachment.url === "string" && attachment.url.length > 0
        )
        .map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mediaType: attachment.mediaType,
          url: attachment.url,
        }))

      return {
        id: message.id,
        role: message.role,
        content: trimMessageContent(message.content.trim()),
        ...(attachments.length > 0 ? { attachments } : {}),
      }
    })
    .filter(
      (message) =>
        message.content.length > 0 || (message.attachments?.length ?? 0) > 0
    )

  const boundedMessages = requestMessageDrafts.slice(
    -AGENT_REQUEST_MAX_MESSAGES
  )

  while (
    boundedMessages.length > 1 &&
    getTotalContentLength(boundedMessages) > AGENT_REQUEST_MAX_TOTAL_CHARS
  ) {
    boundedMessages.shift()
  }

  return boundedMessages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.attachments?.length
      ? { attachments: message.attachments }
      : {}),
  }))
}

export function appendUserMessage(
  currentMessages: AgentMessage[],
  content: string,
  model: ModelType,
  attachments?: MessageAttachment[]
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
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  }

  const lastMessage = currentMessages[currentMessages.length - 1]
  const shouldReplaceLastUnansweredMessage =
    content.trim().length > 0 &&
    lastMessage?.role === "user" &&
    lastMessage.content.trim() === content

  const baseMessages = shouldReplaceLastUnansweredMessage
    ? currentMessages.slice(0, -1)
    : currentMessages

  return [...baseMessages, userMessage]
}
