import { memo, useMemo } from "react"

import {
  type AgentRunMode,
  isAssistantMessage,
  isUserMessage,
  type Message,
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { AssistantMessage, CraftingShimmer } from "./assistant-message"
import { UserMessage } from "./user-message"

function groupMessages(messages: Message[]) {
  const groups: Message[][] = []

  for (const message of messages) {
    if (isUserMessage(message)) {
      groups.push([message])
      continue
    }

    if (!isAssistantMessage(message)) {
      continue
    }

    const lastGroup = groups[groups.length - 1]
    const firstMessageInLastGroup = lastGroup?.[0]

    if (firstMessageInLastGroup && isUserMessage(firstMessageInLastGroup)) {
      lastGroup.push(message)
      continue
    }

    groups.push([message])
  }

  return groups
}

function hasVisibleAssistantActivity(message: Message): boolean {
  const visibleTextParts = (message.metadata?.parts ?? [])
    .map((part) => part.text)
    .join("")
    .trim()
  const visibleText = visibleTextParts || message.content.trim()

  return Boolean(
    visibleText ||
    (message.metadata?.activityTimeline?.length ?? 0) ||
    (message.metadata?.toolInvocations?.length ?? 0) ||
    (message.metadata?.sources?.length ?? 0) ||
    message.metadata?.reasoning?.trim()
  )
}

function MessagesComponent({
  messages,
  disableEditing,
  onEditMessage,
}: {
  messages: Message[]
  disableEditing: boolean
  onEditMessage?: (params: {
    messageId: string
    newContent: string
    newModel: ModelType
    newRunMode: AgentRunMode
  }) => Promise<void> | void
}) {
  const messageGroups = useMemo(() => groupMessages(messages), [messages])

  return (
    <div className="relative z-0 mb-10 flex w-full grow flex-col gap-9">
      {messageGroups.map((messageGroup, groupIndex) => {
        const isLastGroup = groupIndex === messageGroups.length - 1
        const firstMessage = messageGroup[0]
        const lastAssistantMessage = [...messageGroup]
          .reverse()
          .find((message) => isAssistantMessage(message))
        const assistantIsStreaming =
          lastAssistantMessage?.metadata?.isStreaming === true
        const assistantHasVisibleActivity = lastAssistantMessage
          ? hasVisibleAssistantActivity(lastAssistantMessage)
          : false
        const shouldShowGenerating =
          isLastGroup && assistantIsStreaming && !assistantHasVisibleActivity

        return (
          <div
            data-message-group="turn"
            data-user-message-id={
              firstMessage && isUserMessage(firstMessage) ? firstMessage.id : ""
            }
            className={cn(
              "flex flex-col gap-3",
              (messageGroup.length > 1 || shouldShowGenerating) && "gap-4"
            )}
            key={groupIndex}
            style={
              isLastGroup && messageGroups.length > 1
                ? { minHeight: "calc(-200px + 100dvh)" }
                : undefined
            }
          >
            {messageGroup.map((message) => {
              if (isUserMessage(message)) {
                return (
                  <UserMessage
                    key={message.id}
                    message={message}
                    isFirstMessage={groupIndex === 0}
                    disableEditing={disableEditing}
                    onEditMessage={onEditMessage}
                  />
                )
              }

              if (isAssistantMessage(message)) {
                return <AssistantMessage key={message.id} message={message} />
              }

              return null
            })}

            {shouldShowGenerating ? (
              <CraftingShimmer key={`crafting-${String(groupIndex)}`} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export const Messages = memo(MessagesComponent)
