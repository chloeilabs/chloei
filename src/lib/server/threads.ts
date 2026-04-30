import { sql } from "kysely"

import { createLogger } from "@/lib/logger"
import {
  deriveThreadTitle,
  sortThreadsNewestFirst,
  type Thread,
} from "@/lib/shared"

import { isE2eMockModeEnabled } from "./e2e-test-mode"
import { getDatabase } from "./postgres"
import {
  parseStoredThread,
  prepareThreadForPersistence,
  type StoredThreadRow,
} from "./thread-payload"
export { parseThreadPayload } from "./thread-payload"

declare global {
  var chloeiE2eThreads: Map<string, Map<string, Thread>> | undefined
}

const logger = createLogger("thread-store")

const THREAD_STORE_SETUP_MESSAGE =
  "Thread storage is not initialized. Run `pnpm app:migrate` to initialize app tables."
const POSTGRES_UNDEFINED_TABLE_ERROR_CODE = "42P01"
const POSTGRES_UNDEFINED_COLUMN_ERROR_CODE = "42703"

class ThreadStoreNotInitializedError extends Error {
  constructor() {
    super(THREAD_STORE_SETUP_MESSAGE)
    this.name = "ThreadStoreNotInitializedError"
  }
}

function isPostgresErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}

function wrapThreadStoreError(error: unknown): Error {
  if (
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_TABLE_ERROR_CODE) ||
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_COLUMN_ERROR_CODE)
  ) {
    return new ThreadStoreNotInitializedError()
  }

  return error instanceof Error
    ? error
    : new Error("Unknown thread store error.")
}

export function isThreadStoreNotInitializedError(
  error: unknown
): error is ThreadStoreNotInitializedError {
  return error instanceof ThreadStoreNotInitializedError
}

export async function listThreadsForUser(userId: string): Promise<Thread[]> {
  if (isE2eMockModeEnabled()) {
    return sortThreadsNewestFirst([
      ...(globalThis.chloeiE2eThreads?.get(userId)?.values() ?? []),
    ])
  }

  const database = getDatabase()
  const result = await sql<StoredThreadRow>`
    SELECT
      id,
      model,
      messages,
      "createdAt",
      "updatedAt"
    FROM thread
    WHERE "userId" = ${userId}
    ORDER BY "updatedAt" DESC, id ASC
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapThreadStoreError(error)
    })

  const threads: Thread[] = []

  for (const row of result.rows) {
    try {
      threads.push(parseStoredThread(row))
    } catch (error) {
      logger.error("Skipping invalid stored thread.", error)
    }
  }

  return sortThreadsNewestFirst(threads)
}

export async function getThreadForUser(
  userId: string,
  threadId: string
): Promise<Thread | null> {
  if (isE2eMockModeEnabled()) {
    return globalThis.chloeiE2eThreads?.get(userId)?.get(threadId) ?? null
  }

  const database = getDatabase()
  const result = await sql<StoredThreadRow>`
    SELECT
      id,
      model,
      messages,
      "createdAt",
      "updatedAt"
    FROM thread
    WHERE "userId" = ${userId}
      AND id = ${threadId}
    LIMIT 1
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapThreadStoreError(error)
    })

  const row = result.rows[0]
  if (!row) {
    return null
  }

  try {
    return parseStoredThread(row)
  } catch (error) {
    logger.error("Skipping invalid stored thread.", error)
    return null
  }
}

export async function upsertThreadForUser(
  userId: string,
  thread: Thread
): Promise<Thread> {
  if (isE2eMockModeEnabled()) {
    const normalizedThread = prepareThreadForPersistence(thread)
    globalThis.chloeiE2eThreads ??= new Map()

    let userThreads = globalThis.chloeiE2eThreads.get(userId)
    if (!userThreads) {
      userThreads = new Map()
      globalThis.chloeiE2eThreads.set(userId, userThreads)
    }

    const existingThread = userThreads.get(normalizedThread.id)
    const existingUpdatedAt = existingThread
      ? Date.parse(existingThread.updatedAt)
      : Number.NEGATIVE_INFINITY
    const incomingUpdatedAt = Date.parse(normalizedThread.updatedAt)

    if (!existingThread) {
      userThreads.set(normalizedThread.id, normalizedThread)
    } else if (
      Number.isFinite(incomingUpdatedAt) &&
      (!Number.isFinite(existingUpdatedAt) ||
        incomingUpdatedAt >= existingUpdatedAt)
    ) {
      userThreads.set(normalizedThread.id, normalizedThread)
    }

    return userThreads.get(normalizedThread.id) ?? normalizedThread
  }

  const database = getDatabase()
  const normalizedThread = prepareThreadForPersistence(thread)
  const { createdAt, updatedAt } = normalizedThread
  const title = deriveThreadTitle(normalizedThread.messages)

  try {
    await sql`
      INSERT INTO thread (
        "userId",
        id,
        title,
        model,
        messages,
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${userId},
        ${normalizedThread.id},
        ${title},
        ${normalizedThread.model ?? null},
        CAST(${JSON.stringify(normalizedThread.messages)} AS jsonb),
        ${new Date(createdAt)},
        ${new Date(updatedAt)}
      )
      ON CONFLICT ("userId", id)
      DO UPDATE SET
        title = EXCLUDED.title,
        model = EXCLUDED.model,
        messages = EXCLUDED.messages,
        "createdAt" = LEAST(thread."createdAt", EXCLUDED."createdAt"),
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE thread."updatedAt" <= EXCLUDED."updatedAt"
    `.execute(database)
  } catch (error) {
    throw wrapThreadStoreError(error)
  }

  return {
    ...normalizedThread,
    createdAt,
    updatedAt,
  }
}

export async function deleteThreadForUser(userId: string, threadId: string) {
  if (isE2eMockModeEnabled()) {
    globalThis.chloeiE2eThreads?.get(userId)?.delete(threadId)
    return
  }

  const database = getDatabase()

  try {
    await sql`
      DELETE FROM thread
      WHERE "userId" = ${userId}
        AND id = ${threadId}
    `.execute(database)
  } catch (error) {
    throw wrapThreadStoreError(error)
  }
}
