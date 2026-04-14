import type { Message } from "./agent/messages"
import type { ModelType } from "./llm/models"

export const THREADS_STORAGE_KEY = "yurie_threads"
export const LEGACY_THREADS_STORAGE_KEY = "cleo_threads"
export const THREADS_STORAGE_MIGRATION_KEY = "yurie_threads_server_migrated_v1"
export const LEGACY_THREADS_STORAGE_MIGRATION_KEY =
  "cleo_threads_server_migrated_v1"
export const DEFAULT_THREAD_TITLE = "New Conversation"
export const THREAD_TITLE_MAX_LENGTH = 50

export interface Thread {
  id: string
  title: string
  messages: Message[]
  model?: ModelType
  isPinned?: boolean
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

export function normalizeThread(thread: Thread): Thread {
  const nextTitle = thread.title.trim()

  return {
    ...thread,
    isPinned: thread.isPinned ?? false,
    title:
      nextTitle !== ""
        ? nextTitle.slice(0, THREAD_TITLE_MAX_LENGTH)
        : deriveThreadTitle(thread.messages),
  }
}

export function sortThreadsNewestFirst(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => {
    if ((left.isPinned ?? false) !== (right.isPinned ?? false)) {
      return left.isPinned ? -1 : 1
    }

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
