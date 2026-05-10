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
const attachmentConstantsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/agent/attachments.ts")
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
const { AGENT_ATTACHMENT_MAX_FILES } = await import(attachmentConstantsUrl)

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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-default-mode",
  })

  assert(!(defaultModeResult instanceof Response))
  assert.equal(defaultModeResult.parsedRequest.runMode, "chat")
  assert.equal(defaultModeResult.selectedModel, "moonshotai/kimi-k2.6")

  const researchModeResult = parseAgentStreamRequest({
    body: {
      model: "moonshotai/kimi-k2.6",
      runMode: "research",
      messages: [
        {
          role: "user",
          content: "Research this with sources.",
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }, { id: "openai/gpt-5.5" }],
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-research-unavailable",
  })

  assert(unavailableResearchModelResult instanceof Response)
  assert.equal(unavailableResearchModelResult.status, 400)
  assert.deepEqual(await unavailableResearchModelResult.json(), {
    error: "Research mode requires GPT-5.5 model access.",
    errorCode: "AGENT_RESEARCH_MODEL_UNAVAILABLE",
    requestId: "request-research-unavailable",
  })

  const standaloneGptResult = parseAgentStreamRequest({
    body: {
      model: "openai/gpt-5.5",
      messages: [
        {
          role: "user",
          content: "Use GPT as a normal chat model.",
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }, { id: "openai/gpt-5.5" }],
    requestId: "request-standalone-gpt",
  })

  assert(standaloneGptResult instanceof Response)
  assert.equal(standaloneGptResult.status, 400)
  assert.deepEqual(await standaloneGptResult.json(), {
    error: "Unsupported model selected.",
    errorCode: "AGENT_UNSUPPORTED_MODEL",
    requestId: "request-standalone-gpt",
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
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
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
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

test("agent helper validates file attachments and preserves the selected model", async () => {
  const imageAttachment = {
    id: "attachment-1",
    kind: "image",
    filename: "chart.png",
    mediaType: "image/png",
    sizeBytes: 5,
    detail: "auto",
    dataUrl: "data:image/png;base64,aGVsbG8=",
  }

  const attachmentResult = parseAgentStreamRequest({
    body: {
      model: "moonshotai/kimi-k2.6",
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [imageAttachment],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }, { id: "openai/gpt-5.5" }],
    requestId: "request-attachment",
  })

  assert(!(attachmentResult instanceof Response))
  assert.equal(attachmentResult.selectedModel, "moonshotai/kimi-k2.6")
  assert.deepEqual(attachmentResult.parsedRequest.messages[0]?.attachments, [
    imageAttachment,
  ])

  const defaultAttachmentModelResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [imageAttachment],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-default-model",
  })

  assert(!(defaultAttachmentModelResult instanceof Response))
  assert.equal(
    defaultAttachmentModelResult.selectedModel,
    "moonshotai/kimi-k2.6"
  )

  const assistantAttachmentResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "assistant",
          content: "Attached by the wrong role.",
          attachments: [imageAttachment],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-role",
  })

  assert(assistantAttachmentResult instanceof Response)
  assert.equal(assistantAttachmentResult.status, 400)
  assert.deepEqual(await assistantAttachmentResult.json(), {
    error: "Only user messages can include file attachments.",
    errorCode: "AGENT_ATTACHMENT_ROLE_INVALID",
    requestId: "request-attachment-role",
  })

  const badDataUrlResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [
            {
              ...imageAttachment,
              dataUrl: "data:image/jpeg;base64,aGVsbG8=",
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-bad-data-url",
  })

  assert(badDataUrlResult instanceof Response)
  assert.equal(badDataUrlResult.status, 400)
  assert.deepEqual(await badDataUrlResult.json(), {
    error: "Invalid file attachment payload.",
    errorCode: "AGENT_ATTACHMENT_INVALID",
    requestId: "request-attachment-bad-data-url",
  })

  const badPreviewResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [
            {
              ...imageAttachment,
              previewDataUrl: "https://example.com/preview.png",
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-bad-preview",
  })

  assert(badPreviewResult instanceof Response)
  assert.equal(badPreviewResult.status, 400)
  assert.deepEqual(await badPreviewResult.json(), {
    error: "Invalid request payload.",
    errorCode: "AGENT_INVALID_REQUEST",
    requestId: "request-attachment-bad-preview",
  })

  const pdfPreviewResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this PDF.",
          attachments: [
            {
              id: "attachment-pdf-preview",
              kind: "pdf",
              filename: "doc.pdf",
              mediaType: "application/pdf",
              sizeBytes: 5,
              previewDataUrl: "data:image/png;base64,aGVsbG8=",
              dataUrl: "data:application/pdf;base64,aGVsbG8=",
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-pdf-preview",
  })

  assert(pdfPreviewResult instanceof Response)
  assert.equal(pdfPreviewResult.status, 400)
  assert.deepEqual(await pdfPreviewResult.json(), {
    error: "Invalid file attachment payload.",
    errorCode: "AGENT_ATTACHMENT_INVALID",
    requestId: "request-attachment-pdf-preview",
  })

  const whitespaceOnlyBase64Result = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [
            {
              ...imageAttachment,
              sizeBytes: 1,
              dataUrl: "data:image/png;base64,\n \t",
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-empty-base64",
  })

  assert(whitespaceOnlyBase64Result instanceof Response)
  assert.equal(whitespaceOnlyBase64Result.status, 400)
  assert.deepEqual(await whitespaceOnlyBase64Result.json(), {
    error: "Invalid file attachment payload.",
    errorCode: "AGENT_ATTACHMENT_INVALID",
    requestId: "request-attachment-empty-base64",
  })

  const normalizedBase64Result = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this chart.",
          attachments: [
            {
              ...imageAttachment,
              dataUrl: "data:image/png;base64,aGVs\nbG8=",
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachment-normalized-base64",
  })

  assert(!(normalizedBase64Result instanceof Response))
  assert.equal(normalizedBase64Result.selectedModel, "moonshotai/kimi-k2.6")

  const tooManyAttachments = Array.from(
    { length: AGENT_ATTACHMENT_MAX_FILES + 1 },
    (_, index) => ({
      ...imageAttachment,
      id: `attachment-too-many-${String(index)}`,
      filename: `chart-${String(index)}.png`,
    })
  )
  const tooManyPerTurnResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze these charts.",
          attachments: tooManyAttachments,
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachments-too-many-per-turn",
  })

  assert(tooManyPerTurnResult instanceof Response)
  assert.equal(tooManyPerTurnResult.status, 400)
  assert.deepEqual(await tooManyPerTurnResult.json(), {
    error: "Too many file attachments.",
    errorCode: "AGENT_TOO_MANY_ATTACHMENTS",
    requestId: "request-attachments-too-many-per-turn",
  })

  const crossConversationAttachmentsResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze these charts.",
          attachments: tooManyAttachments.slice(0, AGENT_ATTACHMENT_MAX_FILES),
        },
        {
          role: "assistant",
          content: "Done.",
        },
        {
          role: "user",
          content: "Analyze one more chart.",
          attachments: [tooManyAttachments[AGENT_ATTACHMENT_MAX_FILES]],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachments-cross-convo",
  })

  assert(!(crossConversationAttachmentsResult instanceof Response))
  assert.equal(
    crossConversationAttachmentsResult.selectedModel,
    "moonshotai/kimi-k2.6"
  )

  const largePdfDataUrl = `data:application/pdf;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`
  const crossMessageLargeAttachmentsResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze this older PDF.",
          attachments: [
            {
              id: "attachment-cross-large-1",
              kind: "pdf",
              filename: "cross-large-1.pdf",
              mediaType: "application/pdf",
              sizeBytes: 3 * 1024 * 1024,
              dataUrl: largePdfDataUrl,
            },
          ],
        },
        {
          role: "assistant",
          content: "Done.",
        },
        {
          role: "user",
          content: "Compare it to this PDF.",
          attachments: [
            {
              id: "attachment-cross-large-2",
              kind: "pdf",
              filename: "cross-large-2.pdf",
              mediaType: "application/pdf",
              sizeBytes: 3 * 1024 * 1024,
              dataUrl: largePdfDataUrl,
            },
          ],
        },
        {
          role: "assistant",
          content: "Done.",
        },
        {
          role: "user",
          content: "Now include one more PDF.",
          attachments: [
            {
              id: "attachment-cross-large-3",
              kind: "pdf",
              filename: "cross-large-3.pdf",
              mediaType: "application/pdf",
              sizeBytes: 3 * 1024 * 1024,
              dataUrl: largePdfDataUrl,
            },
          ],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachments-cross-message-large",
  })

  assert(!(crossMessageLargeAttachmentsResult instanceof Response))
  assert.equal(
    crossMessageLargeAttachmentsResult.selectedModel,
    "moonshotai/kimi-k2.6"
  )

  const priorAttachmentPayloadsResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze these older PDFs.",
          attachments: [0, 1, 2].map((index) => ({
            id: `attachment-prior-${String(index)}`,
            kind: "pdf",
            filename: `prior-${String(index)}.pdf`,
            mediaType: "application/pdf",
            sizeBytes: 3 * 1024 * 1024,
            dataUrl: largePdfDataUrl,
          })),
        },
        {
          role: "assistant",
          content: "Done.",
        },
        {
          role: "user",
          content: "Now analyze this chart.",
          attachments: [imageAttachment],
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachments-prior-prompt",
  })

  assert(priorAttachmentPayloadsResult instanceof Response)
  assert.equal(priorAttachmentPayloadsResult.status, 413)
  assert.deepEqual(await priorAttachmentPayloadsResult.json(), {
    error: "Attached files are too large.",
    errorCode: "AGENT_ATTACHMENTS_TOO_LARGE",
    requestId: "request-attachments-prior-prompt",
  })

  const oversizedAttachmentsResult = parseAgentStreamRequest({
    body: {
      messages: [
        {
          role: "user",
          content: "Analyze these PDFs.",
          attachments: [0, 1, 2].map((index) => ({
            id: `attachment-large-${String(index)}`,
            kind: "pdf",
            filename: `large-${String(index)}.pdf`,
            mediaType: "application/pdf",
            sizeBytes: 3 * 1024 * 1024,
            dataUrl: largePdfDataUrl,
          })),
        },
      ],
    },
    availableModels: [{ id: "moonshotai/kimi-k2.6" }],
    requestId: "request-attachments-too-large",
  })

  assert(oversizedAttachmentsResult instanceof Response)
  assert.equal(oversizedAttachmentsResult.status, 413)
  assert.deepEqual(await oversizedAttachmentsResult.json(), {
    error: "Attached files are too large.",
    errorCode: "AGENT_ATTACHMENTS_TOO_LARGE",
    requestId: "request-attachments-too-large",
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
    selectedModel: "moonshotai/kimi-k2.6",
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
      financeEnabled: true,
      fmpEnabled: true,
    },
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
            toolName: "tavily_search",
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
    selectedModel: "deepseek/deepseek-v4-pro",
    runMode: "chat",
    aiGatewayApiKey: "ai-gateway-key",
    tavilyApiKey: "tavily-key",
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
            toolName: "tavily_search",
            label: "Searching web",
            query: "Vercel AI Gateway",
          }
          yield {
            type: "tool_result",
            callId: "call-search",
            toolName: "tavily_search",
            status: "error",
            errorCode: "TAVILY_ERROR",
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
    selectedModel: "deepseek/deepseek-v4-pro",
    runMode: "chat",
    aiGatewayApiKey: "ai-gateway-key",
    tavilyApiKey: "tavily-key",
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

test("agent helper commits meaningful completed assistant text for memory", async () => {
  const committed = []

  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield { type: "text_delta", delta: "Remember " }
          yield { type: "text_delta", delta: "this answer." }
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-memory-completed",
    timeoutMs: 30_000,
    selectedModel: "moonshotai/kimi-k2.6",
    aiGatewayApiKey: "ai-gateway-key",
    memoryCommitMaxChars: 13,
    messages: [{ role: "user", content: "Remember me" }],
    systemInstruction: "system",
    onAssistantResponseSettled(params) {
      committed.push(params)
    },
  })

  await readNdjsonEvents(response)

  assert.deepEqual(committed, [
    {
      assistantContent: "Remember this",
      outcome: "completed",
    },
  ])
})

test("agent helper commits meaningful incomplete assistant text for memory", async () => {
  const committed = []

  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield {
            type: "tool_call",
            callId: "call-search",
            toolName: "tavily_search",
            label: "Searching web",
            query: "memory docs",
          }
          yield { type: "text_delta", delta: "Partial but useful." }
        })()
      },
    },
  })

  const response = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-memory-incomplete",
    timeoutMs: 30_000,
    selectedModel: "deepseek/deepseek-v4-pro",
    aiGatewayApiKey: "ai-gateway-key",
    memoryCommitMaxChars: 100,
    messages: [{ role: "user", content: "Search memory docs" }],
    systemInstruction: "system",
    onAssistantResponseSettled(params) {
      committed.push(params)
    },
  })

  await readNdjsonEvents(response)

  assert.deepEqual(committed, [
    {
      assistantContent: "Partial but useful.",
      outcome: "incomplete",
    },
  ])
})

test("agent helper does not commit empty or failed assistant output for memory", async () => {
  const committed = []

  const emptyResponse = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-memory-empty",
    timeoutMs: 30_000,
    selectedModel: "moonshotai/kimi-k2.6",
    aiGatewayApiKey: "ai-gateway-key",
    memoryCommitMaxChars: 100,
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
    onAssistantResponseSettled(params) {
      committed.push(params)
    },
  })

  await readNdjsonEvents(emptyResponse)

  setTestMocks({
    gatewayResponses: {
      startGatewayResponseStream(params) {
        recorded.streamParams.push(params)
        return (async function* () {
          yield { type: "text_delta", delta: "Do not commit this failure." }
          throw new Error("stream failed")
        })()
      },
    },
  })

  const failedResponse = createAgentStreamResponse({
    request: createRequest(),
    requestId: "request-memory-failed",
    timeoutMs: 30_000,
    selectedModel: "moonshotai/kimi-k2.6",
    aiGatewayApiKey: "ai-gateway-key",
    memoryCommitMaxChars: 100,
    messages: [{ role: "user", content: "Hello" }],
    systemInstruction: "system",
    onAssistantResponseSettled(params) {
      committed.push(params)
    },
  })

  await readNdjsonEvents(failedResponse)

  assert.deepEqual(committed, [])
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
    selectedModel: "deepseek/deepseek-v4-pro",
    runMode: "chat",
    aiGatewayApiKey: "ai-gateway-key",
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

  assert.equal(
    response.headers.get("X-Agent-Effective-Model"),
    "openai/gpt-5.5"
  )
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
    selectedModel: "moonshotai/kimi-k2.6",
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
