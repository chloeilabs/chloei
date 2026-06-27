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
      withAiSdkInlineCitationInstruction(instruction) {
        recorded.augmentedInstructions.push({ instruction })
        return `${instruction}::cited`
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
    availableModels: [{ id: "gpt-5.4-mini" }],
    requestId: "request-default-mode",
  })

  assert(!(defaultModeResult instanceof Response))
  assert.equal(defaultModeResult.selectedModel, "gpt-5.4-mini")

  const unavailableModelResult = parseAgentStreamRequest({
    body: {
      model: "openai/gpt-5.5",
      messages: [
        {
          role: "user",
          content: "Use a model the caller cannot access.",
        },
      ],
    },
    availableModels: [{ id: "gpt-5.4-mini" }],
    requestId: "request-unavailable-model",
  })

  assert(unavailableModelResult instanceof Response)
  assert.equal(unavailableModelResult.status, 400)
  assert.deepEqual(await unavailableModelResult.json(), {
    error: "Unsupported model selected.",
    errorCode: "AGENT_UNSUPPORTED_MODEL",
    requestId: "request-unavailable-model",
  })

  const unknownFieldResult = parseAgentStreamRequest({
    body: {
      unknownField: "not allowed",
      messages: [
        {
          role: "user",
          content: "The strict schema should reject unknown fields.",
        },
      ],
    },
    availableModels: [{ id: "gpt-5.4-mini" }],
    requestId: "request-unknown-field",
  })

  assert(unknownFieldResult instanceof Response)
  assert.equal(unknownFieldResult.status, 400)
  assert.deepEqual(await unknownFieldResult.json(), {
    error: "Invalid request payload.",
    errorCode: "AGENT_INVALID_REQUEST",
    requestId: "request-unknown-field",
  })

  const tooManyMessagesResult = parseAgentStreamRequest({
    body: {
      messages: Array.from({ length: 51 }, () => ({
        role: "user",
        content: "hello",
      })),
    },
    availableModels: [{ id: "gpt-5.4-mini" }],
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
    availableModels: [{ id: "gpt-5.4-mini" }],
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
    availableModels: [{ id: "gpt-5.4-mini" }],
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
    availableModels: [{ id: "gpt-5.4-mini" }],
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
    selectedModel: "gpt-5.4-mini",
    openAiApiKey: "openai-key",
    exaApiKey: "exa-key",
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
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
  assert.equal(recorded.streamParams[0]?.systemInstruction, "system::cited")
  assert.deepEqual(recorded.augmentedInstructions[0], {
    instruction: "system",
  })
})

test("agent helper marks tool-backed partial output incomplete when a tool call is unresolved", async () => {
  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield {
            type: "tool_call",
            callId: "call-search",
            toolName: "exa_search",
            label: "Searching web",
            query: "Vercel AI Gateway",
          }
          yield {
            type: "text_delta",
            delta: "One current fact is available.",
          }
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-unresolved-tool",
    timeoutMs: 30_000,
    selectedModel: "gpt-5.4-mini",
    openAiApiKey: "openai-key",
    exaApiKey: "exa-key",
    messages: [{ role: "user", content: "Search latest docs" }],
    systemInstruction: "system",
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events.at(-2), {
    type: "text_delta",
    delta:
      "\n\nA tool request started, but no tool result was returned before the model stopped. Please retry or narrow the request.",
  })
  assert.deepEqual(events.at(-1), {
    type: "agent_status",
    status: "incomplete",
  })
  assert.equal(recorded.loggerInfos[0]?.details?.outcome, "incomplete")
  assert.equal(recorded.loggerInfos[0]?.details?.unresolvedToolCallCount, 1)
})

test("agent helper does not add an incomplete fallback when a meaningful answer follows a tool error", async () => {
  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield {
            type: "tool_call",
            callId: "call-search",
            toolName: "exa_search",
            label: "Searching web",
            query: "Vercel AI Gateway",
          }
          yield {
            type: "tool_result",
            callId: "call-search",
            toolName: "exa_search",
            status: "error",
            errorCode: "EXA_ERROR",
          }
          yield {
            type: "text_delta",
            delta: "One current fact is available.",
          }
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-tool-error",
    timeoutMs: 30_000,
    selectedModel: "gpt-5.4-mini",
    openAiApiKey: "openai-key",
    exaApiKey: "exa-key",
    messages: [{ role: "user", content: "Search latest docs" }],
    systemInstruction: "system",
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events.at(-1), {
    type: "agent_status",
    status: "completed",
  })
  assert.equal(
    events.filter((event) => event.type === "text_delta").at(-1)?.delta,
    "One current fact is available."
  )
  assert.equal(recorded.loggerInfos[0]?.details?.outcome, "completed")
  assert.equal(recorded.loggerInfos[0]?.details?.toolErrorCount, 1)
})

test("agent helper turns upstream body timeouts into visible timeout output", async () => {
  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield { type: "reasoning_delta", delta: "Searching current news." }
          const bodyTimeoutError = Object.assign(
            new Error("Body Timeout Error"),
            {
              code: "UND_ERR_BODY_TIMEOUT",
              name: "BodyTimeoutError",
            }
          )
          throw Object.assign(new TypeError("terminated"), {
            cause: bodyTimeoutError,
          })
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-body-timeout",
    timeoutMs: 30_000,
    selectedModel: "gpt-5.4-mini",
    openAiApiKey: "openai-key",
    messages: [{ role: "user", content: "Latest AI news" }],
    systemInstruction: "system",
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events, [
    { type: "agent_status", status: "in_progress" },
    { type: "reasoning_delta", delta: "Searching current news." },
    { type: "agent_status", status: "failed" },
    {
      type: "text_delta",
      delta: "Sorry, I couldn't finish the response in time. Please retry.",
    },
  ])
  assert.equal(recorded.loggerErrors.length, 0)
  assert.equal(
    recorded.loggerWarnings[0]?.message,
    "Agent stream timed out before completion."
  )
  assert.equal(
    recorded.loggerWarnings[0]?.error?.errorCode,
    "AGENT_STREAM_TIMEOUT"
  )
  assert.equal(recorded.loggerInfos[0]?.details?.outcome, "timeout")
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
    selectedModel: "gpt-5.4-mini",
    openAiApiKey: "openai-key",
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
  })

  const events = await readNdjsonEvents(response)

  assert.deepEqual(events, [
    { type: "agent_status", status: "in_progress" },
    { type: "agent_status", status: "failed" },
    {
      type: "text_delta",
      delta: "Invalid OPENAI_API_KEY on the server.",
    },
  ])
  assert.equal(recorded.loggerErrors.length, 1)
  assert.equal(
    recorded.loggerErrors[0]?.message,
    "AI Gateway authentication failed."
  )
})
