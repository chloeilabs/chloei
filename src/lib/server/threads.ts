import { sql } from "kysely"

import { createLogger } from "@/lib/logger"
import { sortThreadsNewestFirst, type Thread } from "@/lib/shared"

import { getDatabase } from "./postgres"
import {
  parseStoredThread,
  prepareThreadForPersistence,
  type StoredThreadRow,
} from "./thread-payload"
export { parseThreadPayload } from "./thread-payload"

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
  const database = getDatabase()
  const normalizedThread = prepareThreadForPersistence(thread)
  const { createdAt, updatedAt } = normalizedThread

  try {
    await sql`
      INSERT INTO thread (
        "userId",
        id,
        model,
        messages,
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${userId},
        ${normalizedThread.id},
        ${normalizedThread.model ?? null},
        CAST(${JSON.stringify(normalizedThread.messages)} AS jsonb),
        ${new Date(createdAt)},
        ${new Date(updatedAt)}
      )
      ON CONFLICT ("userId", id)
      DO UPDATE SET
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
