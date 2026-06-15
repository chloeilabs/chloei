import {
  type FollowUpQuestion,
  type Message as AgentMessage,
  type ModelType,
} from "@/lib/shared"

import type { AgentStreamAccumulator } from "./agent-stream-state"

function withoutPendingFollowUpQuestions(
  metadata: AgentMessage["metadata"]
): NonNullable<AgentMessage["metadata"]> {
  const nextMetadata = { ...metadata }
  delete nextMetadata.followUpQuestionsPending
  return nextMetadata
}

export function hasVisibleStructuredOutput(
  current: AgentStreamAccumulator
): boolean {
  return Boolean(
    current.reasoning.trim() ||
    current.toolInvocations.length > 0 ||
    current.activityTimeline.length > 0 ||
    current.sources.length > 0
  )
}

export function createAssistantMessageFromAccumulator({
  id,
  createdAt,
  accumulator,
  model,
  isStreaming,
}: {
  id: string
  createdAt: string
  accumulator: AgentStreamAccumulator
  model: ModelType
  isStreaming: boolean
}): AgentMessage {
  return {
    id,
    role: "assistant",
    content: accumulator.content,
    llmModel: model,
    createdAt,
    metadata: {
      isStreaming,
      parts: [{ type: "text", text: accumulator.content }],
      ...(accumulator.agentStatus
        ? { agentStatus: accumulator.agentStatus }
        : {}),
      ...(accumulator.reasoning.trim().length > 0
        ? { reasoning: accumulator.reasoning }
        : {}),
      ...(accumulator.toolInvocations.length > 0
        ? { toolInvocations: accumulator.toolInvocations }
        : {}),
      ...(accumulator.activityTimeline.length > 0
        ? { activityTimeline: accumulator.activityTimeline }
        : {}),
      ...(accumulator.sources.length > 0
        ? { sources: accumulator.sources }
        : {}),
    },
  }
}

export function attachFollowUpQuestionsToMessage(
  currentMessages: AgentMessage[],
  messageId: string,
  followUpQuestions: FollowUpQuestion[]
): AgentMessage[] {
  if (followUpQuestions.length === 0) {
    return currentMessages
  }

  const targetIndex = currentMessages.findIndex(
    (message) => message.id === messageId && message.role === "assistant"
  )
  if (targetIndex === -1) {
    return currentMessages
  }

  return currentMessages.map((message, index) => {
    if (index !== targetIndex) {
      return message
    }

    return {
      ...message,
      metadata: {
        ...withoutPendingFollowUpQuestions(message.metadata),
        followUpQuestions,
      },
    }
  })
}

export function setFollowUpQuestionsPendingForMessage(
  currentMessages: AgentMessage[],
  messageId: string,
  isPending: boolean
): AgentMessage[] {
  const targetIndex = currentMessages.findIndex(
    (message) => message.id === messageId && message.role === "assistant"
  )
  if (targetIndex === -1) {
    return currentMessages
  }

  const targetMessage = currentMessages[targetIndex]
  const currentPending =
    targetMessage?.metadata?.followUpQuestionsPending === true
  if (currentPending === isPending) {
    return currentMessages
  }

  return currentMessages.map((message, index) => {
    if (index !== targetIndex) {
      return message
    }

    if (isPending) {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          followUpQuestionsPending: true,
        },
      }
    }

    return {
      ...message,
      metadata: withoutPendingFollowUpQuestions(message.metadata),
    }
  })
}

export function upsertAgentMessage(
  currentMessages: AgentMessage[],
  nextMessage: AgentMessage
): AgentMessage[] {
  const existingIndex = currentMessages.findIndex(
    (message) => message.id === nextMessage.id
  )

  return existingIndex === -1
    ? [...currentMessages, nextMessage]
    : currentMessages.map((message) =>
        message.id === nextMessage.id ? nextMessage : message
      )
}
