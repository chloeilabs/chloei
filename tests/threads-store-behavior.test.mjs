import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const storeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/threads.ts")
).href

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "kysely": toProjectFileUrl("tests/stubs/kysely.mjs"),
  "./postgres": toProjectFileUrl("tests/stubs/postgres.mjs"),
})

const {
  deleteThreadForUser,
  getThreadForUser,
  isThreadStoreNotInitializedError,
  listThreadsForUser,
  upsertThreadForUser,
} = await import(storeUrl)

let recorded

function createStoredMessage(overrides = {}) {
  return {
    id: "message-1",
    role: "user",
    content: "Stored thread message",
    llmModel: "qwen/qwen3.6-plus",
    createdAt: "2026-04-15T10:00:00.000Z",
    ...overrides,
  }
}

function createStoredRow(overrides = {}) {
  return {
    id: "thread-1",
    title: "Stored title",
    model: "qwen/qwen3.6-plus",
    isPinned: false,
    messages: [createStoredMessage()],
    createdAt: "2026-04-15T10:00:00.000Z",
    updatedAt: "2026-04-15T10:05:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  recorded = {
    loggerErrors: [],
    queries: [],
  }

  resetTestMocks()
  setTestMocks({
    logger: {
      createLogger(scope) {
        return {
          info() {},
          warn() {},
          error(message, error) {
            recorded.loggerErrors.push({ scope, message, error })
          },
        }
      },
    },
    postgres: {
      getDatabase() {
        return { name: "mock-db" }
      },
    },
    kysely: {
      async execute(query) {
        recorded.queries.push(query)
        return { rows: [] }
      },
    },
  })
})

test("listThreadsForUser sorts valid threads and skips invalid rows", async () => {
  setTestMocks({
    kysely: {
      async execute(query) {
        recorded.queries.push(query)
        return {
          rows: [
            createStoredRow({
              id: "unpinned-newer",
              title: "Unpinned newer",
              isPinned: false,
              updatedAt: "2026-04-15T12:05:00.000Z",
            }),
            createStoredRow({
              id: "invalid-row",
              messages: [
                {
                  id: "broken-message",
                  role: "user",
                  content: "Missing llmModel",
                  createdAt: "2026-04-15T09:00:00.000Z",
                },
              ],
            }),
            createStoredRow({
              id: "pinned-older",
              title: "Pinned older",
              isPinned: true,
              updatedAt: "2026-04-15T11:00:00.000Z",
            }),
          ],
        }
      },
    },
  })

  const threads = await listThreadsForUser("user-1")

  assert.deepEqual(
    threads.map((thread) => thread.id),
    ["pinned-older", "unpinned-newer"]
  )
  assert.equal(recorded.queries[0]?.values[0], "user-1")
  assert.equal(recorded.loggerErrors.length, 1)
  assert.equal(
    recorded.loggerErrors[0]?.message,
    "Skipping invalid stored thread."
  )
})

test("getThreadForUser returns null for invalid stored rows", async () => {
  setTestMocks({
    kysely: {
      async execute(query) {
        recorded.queries.push(query)
        return {
          rows: [
            createStoredRow({
              id: "broken-thread",
              createdAt: "not-a-date",
            }),
          ],
        }
      },
    },
  })

  const thread = await getThreadForUser("user-1", "broken-thread")

  assert.equal(thread, null)
  assert.deepEqual(recorded.queries[0]?.values, ["user-1", "broken-thread"])
  assert.equal(recorded.loggerErrors.length, 1)
  assert.equal(
    recorded.loggerErrors[0]?.message,
    "Skipping invalid stored thread."
  )
})

test("thread store wraps missing table errors as initialization failures", async () => {
  setTestMocks({
    kysely: {
      async execute(query) {
        recorded.queries.push(query)
        throw Object.assign(new Error("relation does not exist"), {
          code: "42P01",
        })
      },
    },
  })

  await assert.rejects(
    () => listThreadsForUser("user-1"),
    (error) =>
      isThreadStoreNotInitializedError(error) &&
      error.message ===
        "Thread storage is not initialized. Run `pnpm app:migrate` to initialize app tables."
  )
})

test("upsertThreadForUser normalizes the persisted thread and shapes SQL values", async () => {
  const thread = {
    id: "thread-upsert",
    title: "   ",
    messages: [
      {
        id: "message-upsert",
        role: "user",
        content: "  Derive my title from the first message  ",
        llmModel: "qwen/qwen3.6-plus",
        createdAt: "2026-04-15T09:59:00.000Z",
      },
    ],
    createdAt: "2026-04-15T12:00:00.000Z",
    updatedAt: "2026-04-15T12:05:00.000Z",
  }

  const savedThread = await upsertThreadForUser("user-1", thread)

  assert.equal(savedThread.id, "thread-upsert")
  assert.equal(savedThread.title, "Derive my title from the first message")
  assert.equal(savedThread.createdAt, "2026-04-15T09:59:00.000Z")
  assert.equal(savedThread.updatedAt, "2026-04-15T12:05:00.000Z")
  assert.equal(savedThread.isPinned, false)

  const query = recorded.queries[0]
  assert.match(query.text, /INSERT INTO thread/)
  assert.match(query.text, /ON CONFLICT \("userId", id\)/)
  assert.deepEqual(query.values.slice(0, 5), [
    "user-1",
    "thread-upsert",
    "Derive my title from the first message",
    null,
    false,
  ])
  assert.equal(
    query.values[5],
    JSON.stringify([
      {
        id: "message-upsert",
        role: "user",
        content: "  Derive my title from the first message  ",
        llmModel: "qwen/qwen3.6-plus",
        createdAt: "2026-04-15T09:59:00.000Z",
      },
    ])
  )
  assert(query.values[6] instanceof Date)
  assert.equal(query.values[6].toISOString(), "2026-04-15T09:59:00.000Z")
  assert(query.values[7] instanceof Date)
  assert.equal(query.values[7].toISOString(), "2026-04-15T12:05:00.000Z")
})

test("deleteThreadForUser forwards ids into the delete query", async () => {
  await deleteThreadForUser("user-1", "thread-delete")

  const query = recorded.queries[0]
  assert.match(query.text, /DELETE FROM thread/)
  assert.deepEqual(query.values, ["user-1", "thread-delete"])
})
