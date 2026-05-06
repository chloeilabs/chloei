import type { ModelMessage } from "ai"

function shouldStripReasoningFromStepMessages(model: string): boolean {
  return model.startsWith("xai/")
}

export function stripReasoningFromStepMessages(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message]
    }

    const content = message.content.filter((part) => part.type !== "reasoning")
    if (content.length === message.content.length) {
      return [message]
    }

    if (content.length === 0) {
      return []
    }

    return [
      {
        ...message,
        content,
      },
    ]
  })
}

export function getCompatibleStepMessages(
  model: string,
  messages: readonly ModelMessage[]
): ModelMessage[] | undefined {
  if (!shouldStripReasoningFromStepMessages(model)) {
    return undefined
  }

  const compatibleMessages = stripReasoningFromStepMessages(messages)
  return compatibleMessages.length === messages.length &&
    compatibleMessages.every((message, index) => message === messages[index])
    ? undefined
    : compatibleMessages
}
