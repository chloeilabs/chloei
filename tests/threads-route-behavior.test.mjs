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
        return Response.json(
          { error: "Auth unavailable." },
          {
            status: 503,
            headers,
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

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    error: "Unauthorized.",
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

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: "Invalid thread payload.",
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

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error:
      "Thread storage is not initialized. Run `pnpm threads:migrate` to create the thread table.",
  })
})
