import { type AgentInputItem } from "@openai/agents"

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
  AgentUserModelMessage | AgentAssistantModelMessage

export function toModelMessages(
  messages: AgentInputMessage[]
): AgentModelMessage[] {
  const inputMessages: AgentModelMessage[] = []

  for (const message of messages) {
    const content = message.content.trim()
    const attachments = (message.attachments ?? []).filter(
      (attachment) => Boolean(attachment.fileId) || Boolean(attachment.url)
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

type UserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string | { id: string } }
  | { type: "input_file"; file: string | { id: string }; filename: string }

/**
 * Converts request messages into Agents SDK input items. Assistant history items
 * require a content array of output_text parts (a plain string throws
 * "item.content.map is not a function" on multi-turn). User messages with
 * attachments become a multimodal content array (input_text + input_image /
 * input_file) for vision / PDF analysis. Shared by the single-model and Goblins
 * runtimes.
 */
export function toAgentInputItems(
  messages: AgentInputMessage[]
): AgentInputItem[] {
  return toModelMessages(messages).map((message): AgentInputItem => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.content }],
      }
    }

    const attachments = message.attachments ?? []
    if (attachments.length === 0) {
      return { role: "user", content: message.content }
    }

    const content: UserContentPart[] = []
    if (message.content) {
      content.push({ type: "input_text", text: message.content })
    }
    for (const attachment of attachments) {
      // Prefer the uploaded Files API id (referenced by { id }); fall back to the
      // inline base64 data URL when the upload didn't happen.
      const ref: string | { id: string } | undefined = attachment.fileId
        ? { id: attachment.fileId }
        : attachment.url
      if (!ref) {
        continue
      }
      content.push(
        attachment.kind === "image"
          ? { type: "input_image", image: ref }
          : {
              type: "input_file",
              file: ref,
              filename: attachment.name,
            }
      )
    }
    return { role: "user", content }
  })
}
