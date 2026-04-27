import { type AgentRequestAttachment } from "@/lib/shared"

export interface AgentInputMessage {
  role: "system" | "user" | "assistant"
  content: string
  attachments?: AgentRequestAttachment[]
}

interface AgentTextModelMessagePart {
  type: "text"
  text: string
}

function toModelMessageAttachmentPart(attachment: AgentRequestAttachment) {
  if (attachment.kind === "image") {
    return {
      type: "image" as const,
      image: attachment.dataUrl,
      mediaType: attachment.mediaType,
      providerOptions: {
        openai: {
          imageDetail: attachment.detail ?? "auto",
        },
      },
    }
  }

  return {
    type: "file" as const,
    data: attachment.dataUrl,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
  }
}

type AgentAttachmentModelMessagePart = ReturnType<
  typeof toModelMessageAttachmentPart
>
type AgentUserModelMessagePart =
  | AgentTextModelMessagePart
  | AgentAttachmentModelMessagePart

interface AgentUserModelMessage {
  role: "user"
  content: string | AgentUserModelMessagePart[]
}

interface AgentAssistantModelMessage {
  role: "assistant"
  content: string
}

type AgentModelMessage = AgentUserModelMessage | AgentAssistantModelMessage

function getUserMessageContent(
  content: string,
  attachments: AgentRequestAttachment[]
): AgentUserModelMessage["content"] {
  if (attachments.length === 0) {
    return content
  }

  return [
    {
      type: "text",
      text: content,
    },
    ...attachments.map(toModelMessageAttachmentPart),
  ]
}

export function toModelMessages(
  messages: AgentInputMessage[]
): AgentModelMessage[] {
  const inputMessages: AgentModelMessage[] = []

  for (const message of messages) {
    const content = message.content.trim()
    if (!content) {
      continue
    }

    if (message.role === "system") {
      throw new Error(
        "System messages must be provided via systemInstruction, not messages."
      )
    }

    if (message.role === "assistant") {
      inputMessages.push({
        role: "assistant",
        content,
      })
      continue
    }

    inputMessages.push({
      role: "user",
      content: getUserMessageContent(content, message.attachments ?? []),
    })
  }

  return inputMessages
}
