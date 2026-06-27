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
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const { POST } = await import(routeUrl)

const originalAiGatewayApiKey = process.env.OPENAI_API_KEY

function createRequest(overrides = {}) {
  return {
    headers: new Headers({ "X-Request-Id": "follow-ups-request-1" }),
    signal: AbortSignal.timeout(30_000),
    json: async () => ({
      assistantMessageId: "assistant-1",
      model: "gpt-5.4-mini",
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
  process.env.OPENAI_API_KEY = "test-gateway-key"
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
  })
})

after(() => {
  if (originalAiGatewayApiKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalAiGatewayApiKey
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
