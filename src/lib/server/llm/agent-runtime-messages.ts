import type { MessageAttachment } from "@/lib/shared"

export interface AgentInputMessage {
  role: "system" | "user" | "assistant"
  content: string
  attachments?: MessageAttachment[]
}

interface AgentUserModelMessage {
  role: "user"
  content: string
  attachments?: MessageAttachment[]
}

interface AgentAssistantModelMessage {
  role: "assistant"
  content: string
}

export type AgentModelMessage =
  | AgentUserModelMessage
  | AgentAssistantModelMessage

export function toModelMessages(
  messages: AgentInputMessage[]
): AgentModelMessage[] {
  const inputMessages: AgentModelMessage[] = []

  for (const message of messages) {
    const content = message.content.trim()
    const attachments = (message.attachments ?? []).filter((attachment) =>
      Boolean(attachment.url)
    )

    if (!content && attachments.length === 0) {
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
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
  }

  return inputMessages
}
