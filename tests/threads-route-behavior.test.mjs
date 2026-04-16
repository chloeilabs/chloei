import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import path from "node:path"
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
const routeUrl = pathToFileURL(path.join(cwd, "src/app/api/threads/route.ts")).href

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/auth": toProjectFileUrl("tests/stubs/auth.mjs"),
  "@/lib/server/auth-session": toProjectFileUrl(
    "tests/stubs/auth-session.mjs"
  ),
  "@/lib/server/threads": toProjectFileUrl("tests/stubs/threads.mjs"),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const { DELETE, GET, PUT } = await import(routeUrl)

let recorded

function createRequest(overrides = {}) {
  return {
    headers: new Headers(overrides.headers),
    json: overrides.json ?? (async () => ({})),
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
    loggerErrors: [],
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
          warn() {},
          error(message, error) {
            recorded.loggerErrors.push({ scope, message, error })
          },
        }
      },
    },
    threads: {
      async listThreadsForUser() {
        return []
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
      async listThreadsForUser() {
        const error = new Error(
          "Thread storage is not initialized. Run `pnpm threads:migrate` to create the thread table."
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
      "Thread storage is not initialized. Run `pnpm threads:migrate` to create the thread table.",
    errorCode: "THREAD_STORE_NOT_INITIALIZED",
  })
})
