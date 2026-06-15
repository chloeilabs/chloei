export interface AgentInputMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface AgentUserModelMessage {
  role: "user"
  content: string
}

interface AgentAssistantModelMessage {
  role: "assistant"
  content: string
}

type AgentModelMessage = AgentUserModelMessage | AgentAssistantModelMessage

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
      content,
    })
  }

  return inputMessages
}
