import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
const routeUrl = pathToFileURL(path.join(cwd, "src/app/api/agent/route.ts")).href

setTestModuleStubs({
  "@/lib/actions/api-keys": toProjectFileUrl("tests/stubs/actions-api-keys.mjs"),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/agent-context": toProjectFileUrl(
    "tests/stubs/agent-context.mjs"
  ),
  "@/lib/server/agent-prompt-steering": toProjectFileUrl(
    "tests/stubs/agent-prompt-steering.mjs"
  ),
  "@/lib/server/agent-route": toProjectFileUrl("tests/stubs/agent-route.mjs"),
  "@/lib/server/agent-runtime-config": toProjectFileUrl(
    "tests/stubs/agent-runtime-config.mjs"
  ),
  "@/lib/server/auth": toProjectFileUrl("tests/stubs/auth.mjs"),
  "@/lib/server/auth-session": toProjectFileUrl(
    "tests/stubs/auth-session.mjs"
  ),
  "@/lib/server/rate-limit": toProjectFileUrl("tests/stubs/rate-limit.mjs"),
  "@/lib/server/threads": toProjectFileUrl("tests/stubs/threads.mjs"),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const { POST } = await import(routeUrl)

const originalAiGatewayApiKey = process.env.AI_GATEWAY_API_KEY
const originalTavilyApiKey = process.env.TAVILY_API_KEY
const originalFmpApiKey = process.env.FMP_API_KEY

let recorded

function jsonErrorResponse(params) {
  recorded.jsonErrors.push(params)

  return Response.json(
    {
      error: params.error,
      errorCode: params.errorCode,
      requestId: params.requestId,
    },
    {
      status: params.status,
      headers: {
        "X-Error-Code": params.errorCode,
        "X-Request-Id": params.requestId,
      },
    }
  )
}

async function assertErrorResponse(response, expected) {
  const body = await response.json()

  assert.equal(response.status, expected.status)
  assert.equal(response.headers.get("X-Error-Code"), expected.errorCode)
  assert.equal(response.headers.get("X-Request-Id"), expected.requestId)
  assert.deepEqual(body, {
    error: expected.error,
    errorCode: expected.errorCode,
    requestId: expected.requestId,
  })
}

function createRequest(overrides = {}) {
  return {
    headers: new Headers(overrides.headers),
    signal: overrides.signal ?? new AbortController().signal,
    json: overrides.json ?? (async () => ({ messages: [] })),
  }
}

beforeEach(() => {
  recorded = {
    authUnavailableHeaders: [],
    jsonErrors: [],
    loggerInfos: [],
    loggerErrors: [],
    buildInstructionCalls: [],
    streamCalls: [],
  }

  process.env.AI_GATEWAY_API_KEY = "ai-gateway-key"
  process.env.TAVILY_API_KEY = "tavily-key"
  process.env.FMP_API_KEY = "fmp-key"

  resetTestMocks()
  setTestMocks({
    agentContext: {
      buildAgentSystemInstruction(user, context) {
        recorded.buildInstructionCalls.push({ user, context })
        return "system-instruction"
      },
    },
    agentPromptSteering: {
      inferPromptTaskMode(messages) {
        return messages.length > 1 ? "multi-turn" : "single-turn"
      },
      resolvePromptProvider(model) {
        return `provider:${model}`
      },
    },
    agentRoute: {
      resolveRequestId() {
        return "request-1"
      },
      resolveUserTimeZone() {
        return "America/Chicago"
      },
      createJsonErrorResponse: jsonErrorResponse,
      parseAgentStreamRequest({ body }) {
        return {
          parsedRequest: {
            messages: body.messages,
          },
          selectedModel: "anthropic/claude-sonnet-4.6",
        }
      },
      createAgentStreamResponse(params) {
        recorded.streamCalls.push(params)
        return new Response("stream", { status: 200 })
      },
    },
    auth: {
      isAuthConfigured() {
        return true
      },
      createAuthUnavailableResponse(headers) {
        recorded.authUnavailableHeaders.push(headers)
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
          warn() {},
          error(message, error) {
            recorded.loggerErrors.push({ scope, message, error })
          },
        }
      },
    },
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit() {
        return null
      },
      tryAcquireConcurrencySlot() {
        return null
      },
    },
    threads: {
      isThreadStoreNotInitializedError(error) {
        return error?.code === "THREAD_INIT"
      },
    },
  })
})

after(() => {
  process.env.AI_GATEWAY_API_KEY = originalAiGatewayApiKey
  process.env.TAVILY_API_KEY = originalTavilyApiKey
  process.env.FMP_API_KEY = originalFmpApiKey
})

test("agent route returns auth unavailable when auth is disabled", async () => {
  setTestMocks({
    auth: {
      ...getTestMocks().auth,
      isAuthConfigured() {
        return false
      },
    },
  })

  const response = await POST(createRequest())

  await assertErrorResponse(response, {
    status: 503,
    error: "Auth unavailable.",
    errorCode: "AUTH_UNAVAILABLE",
    requestId: "request-1",
  })
  assert.equal(recorded.streamCalls.length, 0)
  assert.equal(
    new Headers(recorded.authUnavailableHeaders[0]).get("X-Request-Id"),
    "request-1"
  )
})

test("agent route returns a rate-limit error before reading the body", async () => {
  setTestMocks({
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit() {
        return {
          allowed: false,
          retryAfterSeconds: 12,
          limit: 5,
          remaining: 0,
          resetAtEpochSeconds: 123,
        }
      },
      tryAcquireConcurrencySlot() {
        return null
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
    errorCode: "AGENT_RATE_LIMITED",
    requestId: "request-1",
  })
  assert.equal(recorded.jsonErrors[0]?.retryAfterSeconds, 12)
})

test("agent route rejects invalid JSON payloads", async () => {
  const response = await POST(
    createRequest({
      json: async () => {
        throw new Error("Malformed JSON")
      },
    })
  )

  await assertErrorResponse(response, {
    status: 400,
    error: "Invalid JSON payload.",
    errorCode: "AGENT_INVALID_JSON",
    requestId: "request-1",
  })
  assert.equal(recorded.streamCalls.length, 0)
})

test("agent route passes the resolved prompt context into stream creation", async () => {
  const released = []

  setTestMocks({
    rateLimit: {
      evaluateAndConsumeSlidingWindowRateLimit(params) {
        recorded.rateLimitParams = params
        return {
          allowed: true,
          retryAfterSeconds: null,
          limit: 5,
          remaining: 4,
          resetAtEpochSeconds: 123,
        }
      },
      tryAcquireConcurrencySlot(params) {
        recorded.concurrencyParams = params
        return {
          allowed: true,
          retryAfterSeconds: null,
          release() {
            released.push("released")
          },
        }
      },
    },
  })

  const response = await POST(
    createRequest({
      headers: {
        "x-user-timezone": "America/Chicago",
      },
      json: async () => ({
        messages: [
          { role: "user", content: "What changed?" },
          { role: "assistant", content: "Here is the summary." },
        ],
      }),
    })
  )

  assert.equal(response.status, 200)
  assert.equal(await response.text(), "stream")
  assert.equal(recorded.buildInstructionCalls.length, 1)
  assert.deepEqual(recorded.buildInstructionCalls[0], {
    user: {
      id: "user-1",
      name: "Chloei",
      email: "user@example.com",
    },
    context: {
      now: recorded.buildInstructionCalls[0].context.now,
      userTimeZone: "America/Chicago",
      provider: "provider:anthropic/claude-sonnet-4.6",
      taskMode: "multi-turn",
    },
  })
  assert.deepEqual(recorded.streamCalls[0]?.messages, [
    { role: "user", content: "What changed?" },
    { role: "assistant", content: "Here is the summary." },
  ])
  assert.equal(recorded.streamCalls[0]?.aiGatewayApiKey, "ai-gateway-key")
  assert.equal(recorded.streamCalls[0]?.tavilyApiKey, "tavily-key")
  assert.equal(recorded.streamCalls[0]?.fmpApiKey, "fmp-key")
  assert.equal(recorded.streamCalls[0]?.systemInstruction, "system-instruction")
  assert.equal(typeof recorded.streamCalls[0]?.onStreamSettled, "function")

  recorded.streamCalls[0].onStreamSettled()
  assert.deepEqual(released, ["released"])
})
