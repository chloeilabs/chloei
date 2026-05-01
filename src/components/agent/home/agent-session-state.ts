import {
  type AgentRequestAttachment,
  type AgentRunMode,
  type Message as AgentMessage,
  type ModelType,
} from "@/lib/shared"

import type { AgentStreamAccumulator } from "./agent-stream-state"

export type AttachmentPayloadsByThread = Map<
  string,
  Map<string, AgentRequestAttachment[]>
>

export function getThreadAttachmentPayloads(
  payloadsByThread: AttachmentPayloadsByThread,
  threadId: string
) {
  let payloads = payloadsByThread.get(threadId)

  if (!payloads) {
    payloads = new Map<string, AgentRequestAttachment[]>()
    payloadsByThread.set(threadId, payloads)
  }

  return payloads
}

export function pruneThreadAttachmentPayloads(
  payloadsByThread: AttachmentPayloadsByThread,
  threadId: string,
  messages: readonly AgentMessage[]
) {
  const payloads = payloadsByThread.get(threadId)
  if (!payloads) {
    return
  }

  const messageIds = new Set(
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.id)
  )

  for (const messageId of payloads.keys()) {
    if (!messageIds.has(messageId)) {
      payloads.delete(messageId)
    }
  }

  if (payloads.size === 0) {
    payloadsByThread.delete(threadId)
  }
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
  runMode,
  isStreaming,
}: {
  id: string
  createdAt: string
  accumulator: AgentStreamAccumulator
  model: ModelType
  runMode: AgentRunMode
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
      runMode,
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
