import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routeUrl = pathToFileURL(
  path.join(cwd, "src/app/api/agent/follow-ups/route.ts")
).href

setTestModuleStubs({
  "@/lib/actions/api-keys": toProjectFileUrl(
    "tests/stubs/actions-api-keys.mjs"
  ),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/agent-runtime-config": toProjectFileUrl(
    "tests/stubs/agent-runtime-config.mjs"
  ),
  "@/lib/server/auth": toProjectFileUrl("tests/stubs/auth.mjs"),
  "@/lib/server/auth-session": toProjectFileUrl("tests/stubs/auth-session.mjs"),
  "@/lib/server/rate-limit": toProjectFileUrl("tests/stubs/rate-limit.mjs"),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const { POST } = await import(routeUrl)

const originalAiGatewayApiKey = process.env.AI_GATEWAY_API_KEY

function createRequest(overrides = {}) {
  return {
    headers: new Headers({ "X-Request-Id": "follow-ups-request-1" }),
    signal: AbortSignal.timeout(30_000),
    json: async () => ({
      assistantMessageId: "assistant-1",
      model: "moonshotai/kimi-k2.6",
      threadId: "thread-1",
      messages: [
        { role: "user", content: "Explain love" },
        {
          role: "assistant",
          content:
            "Love includes intimacy, commitment, repair after conflict, and care over time.",
        },
      ],
    }),
    ...overrides,
  }
}

async function assertErrorResponse(response, expected) {
  const body = await response.json()

  assert.equal(response.status, expected.status)
  assert.deepEqual(body, {
    error: expected.error,
    errorCode: expected.errorCode,
    requestId: "follow-ups-request-1",
  })
  assert.equal(response.headers.get("X-Error-Code"), expected.errorCode)
  assert.equal(response.headers.get("X-Request-Id"), "follow-ups-request-1")
}

beforeEach(() => {
  resetTestMocks()
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key"
  setTestMocks({
    authSession: {
      getRequestSession() {
        return {
          user: {
            id: "user-1",
            email: "user@example.com",
            name: "User",
          },
        }
      },
    },
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit() {
        return {
          allowed: true,
          limit: 5,
          remaining: 4,
          resetAtEpochSeconds: 123,
          retryAfterSeconds: null,
        }
      },
      tryAcquireConcurrencySlot() {
        return {
          allowed: true,
          inFlight: 1,
          limit: 2,
          release() {},
          retryAfterSeconds: null,
        }
      },
    },
  })
})

after(() => {
  if (originalAiGatewayApiKey === undefined) {
    delete process.env.AI_GATEWAY_API_KEY
  } else {
    process.env.AI_GATEWAY_API_KEY = originalAiGatewayApiKey
  }
})

test("follow-ups route returns a 400 for invalid JSON", async () => {
  const response = await POST(
    createRequest({
      json: async () => {
        throw new SyntaxError("Malformed JSON")
      },
    })
  )

  await assertErrorResponse(response, {
    status: 400,
    error: "Invalid JSON payload.",
    errorCode: "FOLLOW_UPS_INVALID_JSON",
  })
})

test("follow-ups route rate-limits before reading the request body", async () => {
  setTestMocks({
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit() {
        return {
          allowed: false,
          limit: 5,
          remaining: 0,
          resetAtEpochSeconds: 123,
          retryAfterSeconds: 12,
        }
      },
      tryAcquireConcurrencySlot() {
        throw new Error("Concurrency should not be checked when rate-limited.")
      },
    },
  })

  const response = await POST(
    createRequest({
      json: async () => {
        throw new Error("Body should not be read when rate-limited.")
      },
    })
  )

  await assertErrorResponse(response, {
    status: 429,
    error: "Too many requests. Please retry shortly.",
    errorCode: "FOLLOW_UPS_RATE_LIMITED",
  })
  assert.equal(response.headers.get("Retry-After"), "12")
})

test("follow-ups route rejects concurrent generation before Gateway calls", async () => {
  setTestMocks({
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit() {
        return {
          allowed: true,
          limit: 5,
          remaining: 4,
          resetAtEpochSeconds: 123,
          retryAfterSeconds: null,
        }
      },
      tryAcquireConcurrencySlot() {
        return {
          allowed: false,
          inFlight: 2,
          limit: 2,
          release() {},
          retryAfterSeconds: 1,
        }
      },
    },
  })

  const response = await POST(createRequest())

  await assertErrorResponse(response, {
    status: 429,
    error: "Too many concurrent requests. Please retry shortly.",
    errorCode: "FOLLOW_UPS_CONCURRENCY_LIMITED",
  })
  assert.equal(response.headers.get("Retry-After"), "1")
})
