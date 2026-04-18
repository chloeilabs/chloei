import type { Message } from "./agent/messages"
import type { ModelType } from "./llm/models"

export const DEFAULT_THREAD_TITLE = "New Conversation"
export const THREAD_TITLE_MAX_LENGTH = 50

export interface Thread {
  id: string
  messages: Message[]
  model?: ModelType
  createdAt: string
  updatedAt: string
}

function getSortTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function deriveThreadTitle(messages: Message[]): string {
  const firstMessageContent = messages[0]?.content.trim() ?? ""
  return firstMessageContent !== ""
    ? firstMessageContent.slice(0, THREAD_TITLE_MAX_LENGTH)
    : DEFAULT_THREAD_TITLE
}

export function sortThreadsNewestFirst(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => {
    const updatedDelta =
      getSortTimestamp(right.updatedAt) - getSortTimestamp(left.updatedAt)

    if (updatedDelta !== 0) {
      return updatedDelta
    }

    const createdDelta =
      getSortTimestamp(right.createdAt) - getSortTimestamp(left.createdAt)

    if (createdDelta !== 0) {
      return createdDelta
    }

    return left.id.localeCompare(right.id)
  })
}
