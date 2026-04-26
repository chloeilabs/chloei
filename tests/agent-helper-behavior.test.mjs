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
const helperUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-route.ts")
).href

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "./llm/gateway-responses": toProjectFileUrl(
    "tests/stubs/gateway-responses.mjs"
  ),
  "./llm/system-instruction-augmentations": toProjectFileUrl(
    "tests/stubs/system-instruction-augmentations.mjs"
  ),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const {
  createAgentStreamResponse,
  createJsonErrorResponse,
  parseAgentStreamRequest,
  resolveRequestId,
  resolveUserTimeZone,
} = await import(helperUrl)

let recorded

function createRequest(headers = {}) {
  return {
    headers: new Headers(headers),
    signal: new AbortController().signal,
  }
}

async function readNdjsonEvents(response) {
  const body = await response.text()
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function* createEmptyStream() {
  yield* []
}

beforeEach(() => {
  recorded = {
    streamParams: [],
    augmentedInstructions: [],
    loggerInfos: [],
    loggerErrors: [],
    loggerWarnings: [],
    settledCount: 0,
  }

  resetTestMocks()
  setTestMocks({
    logger: {
      createLogger(scope) {
        return {
          info(message, details) {
            recorded.loggerInfos.push({ scope, message, details })
          },
          warn(message, error) {
            recorded.loggerWarnings.push({ scope, message, error })
          },
          error(message, error) {
            recorded.loggerErrors.push({ scope, message, error })
          },
        }
      },
    },
    systemInstructionAugmentations: {
      withAiSdkInlineCitationInstruction(instruction, options) {
        recorded.augmentedInstructions.push({ instruction, options })
        return `${instruction}::fmp=${String(options.fmpEnabled)}`
      },
    },
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {})()
      },
    },
  })
})

test("agent helper resolves request ids and time zones from headers", () => {
  assert.equal(
    resolveRequestId(createRequest({ "x-request-id": " request-123 " })),
    "request-123"
  )
  assert.equal(
    resolveUserTimeZone(
      createRequest({ "x-user-timezone": "America/Chicago" })
    ),
    "America/Chicago"
  )
  assert.equal(
    resolveUserTimeZone(createRequest({ "x-user-timezone": "Not/AZone" })),
    undefined
  )
})

test("agent helper error responses include rate-limit headers", async () => {
  const response = createJsonErrorResponse({
    requestId: "request-1",
    error: "Too many requests.",
    errorCode: "AGENT_RATE_LIMITED",
    status: 429,
    retryAfterSeconds: 9,
    rateLimitDecision: {
      allowed: false,
      retryAfterSeconds: 9,
      limit: 5,
      remaining: 0,
      resetAtEpochSeconds: 123,
    },
  })

  assert.equal(response.status, 429)
  assert.equal(response.headers.get("X-Error-Code"), "AGENT_RATE_LIMITED")
  assert.equal(response.headers.get("X-Request-Id"), "request-1")
  assert.equal(response.headers.get("Retry-After"), "9")
  assert.equal(response.headers.get("X-RateLimit-Limit"), "5")
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0")
  assert.equal(response.headers.get("X-RateLimit-Reset"), "123")
  assert.deepEqual(await response.json(), {
    error: "Too many requests.",
    errorCode: "AGENT_RATE_LIMITED",
    requestId: "request-1",
  })
})

test("agent helper validates total size, last-message role, and default model support", async () => {
  const defaultModeResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Use the default model.",
        },
      ],
    },
    availableModels: [{ id: "openai/gpt-5.5" }],
    requestId: "request-default-mode",
  })

  assert(!(defaultModeResult instanceof Response))
  assert.equal(defaultModeResult.parsedRequest.runMode, "chat")
  assert.equal(defaultModeResult.selectedModel, "openai/gpt-5.5")

  const researchModeResult = parseAgentStreamRequest({
    body: {
      model: "anthropic/claude-sonnet-4.6",
      runMode: "research",
      messages: [
        {
          role: "user",
          content: "Research this with sources.",
        },
      ],
    },
    availableModels: [
      { id: "anthropic/claude-sonnet-4.6" },
      { id: "openai/gpt-5.5" },
    ],
    requestId: "request-research-mode",
  })

  assert(!(researchModeResult instanceof Response))
  assert.equal(researchModeResult.parsedRequest.runMode, "research")
  assert.equal(researchModeResult.selectedModel, "openai/gpt-5.5")

  const unavailableResearchModelResult = parseAgentStreamRequest({
    body: {
      runMode: "research",
      messages: [
        {
          role: "user",
          content: "Research this with sources.",
        },
      ],
    },
    availableModels: [{ id: "anthropic/claude-sonnet-4.6" }],
    requestId: "request-research-unavailable",
  })

  assert(unavailableResearchModelResult instanceof Response)
  assert.equal(unavailableResearchModelResult.status, 400)
  assert.deepEqual(await unavailableResearchModelResult.json(), {
    error: "Research mode requires GPT-5.5 model access.",
    errorCode: "AGENT_RESEARCH_MODEL_UNAVAILABLE",
    requestId: "request-research-unavailable",
  })

  const invalidRunModeResult = parseAgentStreamRequest({
    body: {
      runMode: "deep",
      messages: [
        {
          role: "user",
          content: "Use an invalid mode.",
        },
      ],
    },
    availableModels: [{ id: "openai/gpt-5.5" }],
    requestId: "request-invalid-mode",
  })

  assert(invalidRunModeResult instanceof Response)
  assert.equal(invalidRunModeResult.status, 400)
  assert.deepEqual(await invalidRunModeResult.json(), {
    error: "Invalid request payload.",
    errorCode: "AGENT_INVALID_REQUEST",
    requestId: "request-invalid-mode",
  })

  const tooManyMessagesResult = parseAgentStreamRequest({
    body: {
      messages: Array.from({ length: 51 }, () => ({
        role: "user",
        content: "hello",
      })),
    },
    availableModels: [{ id: "anthropic/claude-sonnet-4.6" }],
    requestId: "request-too-many",
  })

  assert(tooManyMessagesResult instanceof Response)
  assert.equal(tooManyMessagesResult.status, 400)
  assert.deepEqual(await tooManyMessagesResult.json(), {
    error: "Conversation has too many messages.",
    errorCode: "AGENT_TOO_MANY_MESSAGES",
    requestId: "request-too-many",
  })

  const oversizedMessageResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "x".repeat(12_001),
        },
      ],
    },
    availableModels: [{ id: "anthropic/claude-sonnet-4.6" }],
    requestId: "request-message-too-large",
  })

  assert(oversizedMessageResult instanceof Response)
  assert.equal(oversizedMessageResult.status, 413)
  assert.deepEqual(await oversizedMessageResult.json(), {
    error: "A conversation message is too large.",
    errorCode: "AGENT_MESSAGE_TOO_LARGE",
    requestId: "request-message-too-large",
  })

  const oversizedResult = parseAgentStreamRequest({
    body: {
      messages: Array.from({ length: 5 }, (_, index) => ({
        role: "user",
        content: `${String(index).padStart(2, "0")}${"x".repeat(10_998)}`,
      })),
    },
    availableModels: [{ id: "anthropic/claude-sonnet-4.6" }],
    requestId: "request-1",
  })

  assert(oversizedResult instanceof Response)
  assert.equal(oversizedResult.status, 413)
  assert.deepEqual(await oversizedResult.json(), {
    error: "Conversation payload is too large.",
    errorCode: "AGENT_PAYLOAD_TOO_LARGE",
    requestId: "request-1",
  })

  const lastAssistantResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "assistant",
          content: "I should not be last.",
        },
      ],
    },
    availableModels: [{ id: "anthropic/claude-sonnet-4.6" }],
    requestId: "request-2",
  })

  assert(lastAssistantResult instanceof Response)
  assert.equal(lastAssistantResult.status, 400)
  assert.deepEqual(await lastAssistantResult.json(), {
    error: "The final message must be from the user.",
    errorCode: "AGENT_FINAL_MESSAGE_INVALID",
    requestId: "request-2",
  })

  const unsupportedModelResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Use the default model.",
        },
      ],
    },
    availableModels: [{ id: "not-supported-model" }],
    requestId: "request-3",
  })

  assert(unsupportedModelResult instanceof Response)
  assert.equal(unsupportedModelResult.status, 400)
  assert.deepEqual(await unsupportedModelResult.json(), {
    error: "Unsupported model selected.",
    errorCode: "AGENT_UNSUPPORTED_MODEL",
    requestId: "request-3",
  })
})

test("agent helper streams fallback output when the model yields no content", async () => {
  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return createEmptyStream()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-1",
    timeoutMs: 30_000,
    selectedModel: "anthropic/claude-sonnet-4.6",
    runMode: "chat",
    aiGatewayApiKey: "ai-gateway-key",
    tavilyApiKey: "tavily-key",
    fmpApiKey: "fmp-key",
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
    onStreamSettled() {
      recorded.settledCount += 1
    },
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events, [
    { type: "agent_status", status: "in_progress" },
    {
      type: "text_delta",
      delta:
        "Sorry, I couldn't generate a response from that input. Please retry.",
    },
    { type: "agent_status", status: "completed" },
  ])
  assert.equal(recorded.settledCount, 1)
  assert.equal(recorded.streamParams[0]?.systemInstruction, "system::fmp=true")
  assert.deepEqual(recorded.augmentedInstructions[0], {
    instruction: "system",
    options: {
      fmpEnabled: true,
    },
  })
})

test("agent helper forwards the deep research runtime profile", async () => {
  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-research",
    timeoutMs: 30_000,
    selectedModel: "openai/gpt-5.5",
    runMode: "research",
    aiGatewayApiKey: "ai-gateway-key",
    runtimeProfile: "deep_research",
    messages: [{ role: "user", content: "Research with sources" }],
    systemInstruction: "system",
  })

  await readNdjsonEvents(response)

  assert.equal(recorded.streamParams[0]?.model, "openai/gpt-5.5")
  assert.equal(recorded.streamParams[0]?.runtimeProfile, "deep_research")
})

test("agent helper returns an auth-key fallback when provider auth fails", async () => {
  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield* []
          throw Object.assign(new Error("Bad api key"), { status: 401 })
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-2",
    timeoutMs: 30_000,
    selectedModel: "anthropic/claude-sonnet-4.6",
    runMode: "chat",
    aiGatewayApiKey: "ai-gateway-key",
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events, [
    { type: "agent_status", status: "in_progress" },
    { type: "agent_status", status: "failed" },
    {
      type: "text_delta",
      delta: "Invalid AI_GATEWAY_API_KEY on the server.",
    },
  ])
  assert.equal(recorded.loggerErrors.length, 1)
  assert.equal(
    recorded.loggerErrors[0]?.message,
    "AI Gateway authentication failed."
  )
})
