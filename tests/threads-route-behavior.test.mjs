import assert from "node:assert/strict"
import path from "node:path"
import { beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { ZodError } from "zod"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import {
  getTestMocks,
  resetTestMocks,
  setTestMocks,
} from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routeUrl = pathToFileURL(
  path.join(cwd, "src/app/api/threads/route.ts")
).href

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/auth": toProjectFileUrl("tests/stubs/auth.mjs"),
  "@/lib/server/auth-session": toProjectFileUrl("tests/stubs/auth-session.mjs"),
  "@/lib/server/threads": toProjectFileUrl("tests/stubs/threads.mjs"),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const { DELETE, GET, PUT } = await import(routeUrl)

let recorded

function createRequest(overrides = {}) {
  return {
    headers: new Headers(overrides.headers),
    json: overrides.json ?? (async () => ({})),
    nextUrl: overrides.nextUrl ?? new URL("https://chloei.example/api/threads"),
    signal: overrides.signal ?? new AbortController().signal,
  }
}

async function assertApiErrorResponse(response, expected) {
  const body = await response.json()

  assert.equal(response.status, expected.status)
  assert.equal(response.headers.get("X-Error-Code"), expected.errorCode)
  assert.equal(body.error, expected.error)
  assert.equal(body.errorCode, expected.errorCode)
  assert.equal(typeof body.requestId, "string")
  assert.ok(body.requestId.length > 0)
  assert.equal(response.headers.get("X-Request-Id"), body.requestId)
}

beforeEach(() => {
  recorded = {
    deleted: [],
    loggerInfos: [],
    loggerErrors: [],
    loggerWarnings: [],
  }

  resetTestMocks()
  setTestMocks({
    auth: {
      isAuthConfigured() {
        return true
      },
      createAuthUnavailableResponse(headers) {
        const responseHeaders = new Headers(headers)
        const requestId =
          responseHeaders.get("X-Request-Id")?.trim() ??
          "request-auth-unavailable"
        responseHeaders.set("X-Error-Code", "AUTH_UNAVAILABLE")
        responseHeaders.set("X-Request-Id", requestId)

        return Response.json(
          {
            error: "Auth unavailable.",
            errorCode: "AUTH_UNAVAILABLE",
            requestId,
          },
          {
            status: 503,
            headers: responseHeaders,
          }
        )
      },
    },
    authSession: {
      async getRequestSession() {
        return {
          user: {
            id: "user-1",
            name: "Chloei",
            email: "user@example.com",
          },
        }
      },
    },
    logger: {
      createLogger(scope) {
        return {
          info(message, details) {
            recorded.loggerInfos.push({ scope, message, details })
          },
          warn(message, details) {
            recorded.loggerWarnings.push({ scope, message, details })
          },
          error(message, error) {
            recorded.loggerErrors.push({ scope, message, error })
          },
        }
      },
    },
    threads: {
      async listThreadSummariesForUser() {
        return []
      },
      async getThreadForUser() {
        return null
      },
      parseThreadPayload(payload) {
        return payload
      },
      async upsertThreadForUser(userId, thread) {
        return { ...thread, userId }
      },
      async deleteThreadForUser(userId, threadId) {
        recorded.deleted.push({ userId, threadId })
      },
      isThreadStoreNotInitializedError(error) {
        return error?.code === "THREAD_INIT"
      },
    },
  })
})

test("threads GET returns unauthorized when no session is available", async () => {
  setTestMocks({
    authSession: {
      async getRequestSession() {
        return null
      },
    },
  })

  const response = await GET(createRequest())

  await assertApiErrorResponse(response, {
    status: 401,
    error: "Unauthorized.",
    errorCode: "THREADS_UNAUTHORIZED",
  })
})

test("threads GET returns metadata-only thread summaries by default", async () => {
  setTestMocks({
    threads: {
      ...getTestMocks().threads,
      async listThreadSummariesForUser(userId) {
        assert.equal(userId, "user-1")
        return [
          {
            id: "thread-1",
            title: "Summarized thread",
            createdAt: "2026-04-15T10:00:00.000Z",
            updatedAt: "2026-04-15T10:05:00.000Z",
          },
        ]
      },
    },
  })

  const response = await GET(createRequest())
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(body, [
    {
      id: "thread-1",
      title: "Summarized thread",
      createdAt: "2026-04-15T10:00:00.000Z",
      updatedAt: "2026-04-15T10:05:00.000Z",
    },
  ])
})

test("threads GET returns a full thread when an id is requested", async () => {
  setTestMocks({
    threads: {
      ...getTestMocks().threads,
      async getThreadForUser(userId, threadId) {
        assert.equal(userId, "user-1")
        assert.equal(threadId, "thread-1")
        return {
          id: "thread-1",
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "Open the thread",
              llmModel: "gpt-5.6-terra",
              createdAt: "2026-04-15T10:00:00.000Z",
            },
          ],
          createdAt: "2026-04-15T10:00:00.000Z",
          updatedAt: "2026-04-15T10:05:00.000Z",
        }
      },
    },
  })

  const response = await GET(
    createRequest({
      nextUrl: new URL("https://chloei.example/api/threads?id=thread-1"),
    })
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.id, "thread-1")
  assert.equal(body.messages[0]?.content, "Open the thread")
})

test("threads PUT returns 400 for invalid thread payloads", async () => {
  setTestMocks({
    threads: {
      ...getTestMocks().threads,
      parseThreadPayload() {
        throw new ZodError([])
      },
    },
  })

  const response = await PUT(
    createRequest({
      json: async () => ({ id: "thread-1" }),
    })
  )

  await assertApiErrorResponse(response, {
    status: 400,
    error: "Invalid thread payload.",
    errorCode: "THREADS_INVALID_PAYLOAD",
  })
})

test("threads DELETE returns 204 and forwards the user and thread ids", async () => {
  const response = await DELETE(
    createRequest({
      json: async () => ({ id: "thread-1" }),
    })
  )

  assert.equal(response.status, 204)
  assert.deepEqual(recorded.deleted, [
    {
      userId: "user-1",
      threadId: "thread-1",
    },
  ])
})

test("threads GET surfaces thread-store initialization errors", async () => {
  setTestMocks({
    threads: {
      ...getTestMocks().threads,
      async listThreadSummariesForUser() {
        const error = new Error(
          "Thread storage is not initialized. Run `pnpm app:migrate` to initialize app tables."
        )
        error.code = "THREAD_INIT"
        throw error
      },
    },
  })

  const response = await GET(createRequest())

  await assertApiErrorResponse(response, {
    status: 500,
    error:
      "Thread storage is not initialized. Run `pnpm app:migrate` to initialize app tables.",
    errorCode: "THREAD_STORE_NOT_INITIALIZED",
  })
})
