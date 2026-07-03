import { type NextRequest } from "next/server"
import { z } from "zod"

import { asRecord, asString, isAbortError } from "@/lib/cast"
import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import type { AgentFeatureFlags } from "@/lib/server/integration-flags"
import {
  type AgentStreamEvent,
  ALL_MODELS,
  isGoblinsModel,
  MODEL_SELECTOR_MODELS,
  type ModelInfo,
  type ModelType,
  resolveDefaultModelSelectorModel,
} from "@/lib/shared"
import {
  AGENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  AGENT_MAX_ATTACHMENTS_PER_MESSAGE,
  AGENT_SUPPORTED_ATTACHMENT_MEDIA_TYPES,
} from "@/lib/shared/agent-request-limits"

import {
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_TOTAL_CHARS,
} from "./agent-runtime-config"
import { createApiErrorBody, createApiHeaders } from "./api-response"
import { startGatewayResponseStream } from "./llm/gateway-responses"
import { withAiSdkInlineCitationInstruction } from "./llm/system-instruction-augmentations"

const STREAM_TIMEOUT_FALLBACK_TEXT =
  "Sorry, I couldn't finish the response in time. Please retry."
const STREAM_ERROR_FALLBACK_TEXT =
  "Sorry, I hit an error while generating a response. Please retry."
const STRUCTURED_OUTPUT_ONLY_FALLBACK_TEXT =
  "I produced intermediate output, but the model ended before writing a final answer. Please retry or narrow the request."
const TOOL_OUTPUT_ONLY_FALLBACK_TEXT =
  "I gathered tool results, but the model ended before writing a final answer. Please retry or narrow the request; the tool output above is still available for inspection."
const TOOL_CALL_INCOMPLETE_FALLBACK_TEXT =
  "A tool request started, but no tool result was returned before the model stopped. Please retry or narrow the request."

const TIMEOUT_ERROR_CODES = new Set([
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])
const TIMEOUT_ERROR_NAMES = new Set([
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "GatewayTimeoutError",
  "HeadersTimeoutError",
  "TimeoutError",
])

const attachmentRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["image", "pdf"]),
    name: z.string().trim().min(1).max(500),
    mediaType: z.enum(AGENT_SUPPORTED_ATTACHMENT_MEDIA_TYPES),
    // A new attachment arrives as a base64 data URL; once uploaded to the Files
    // API it round-trips as a fileId (and the client drops the url). At least
    // one is required.
    url: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_ATTACHMENT_MAX_DATA_URL_CHARS)
      .startsWith("data:")
      .optional(),
    fileId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (attachment) => Boolean(attachment.url) || Boolean(attachment.fileId),
    {
      message: "An attachment must include a data URL or a fileId.",
    }
  )

const agentMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim(),
    attachments: z
      .array(attachmentRequestSchema)
      .max(AGENT_MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
  })
  .strict()
  .refine(
    (message) =>
      message.content.length > 0 || (message.attachments?.length ?? 0) > 0,
    { message: "A message must include text or at least one attachment." }
  )

export const agentStreamRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    messages: z.array(agentMessageSchema).min(1),
    // Requests a durable background Goblins run (deep research). Honored only
    // for the goblins model with the escalation flag on and a threadId to fold
    // the answer into; otherwise the request silently runs interactive.
    background: z.boolean().optional(),
  })
  .strict()

type AgentStreamRequest = z.infer<typeof agentStreamRequestSchema>
interface ParsedAgentStreamRequest {
  parsedRequest: AgentStreamRequest
  selectedModel: ModelType
}

interface JsonErrorResponseParams {
  requestId: string
  error: string
  errorCode: string
  status: number
}

interface ParseAgentStreamRequestParams {
  body: unknown
  availableModels: readonly Pick<ModelInfo, "id">[]
  requestId: string
}

interface CreateAgentStreamResponseParams {
  request: NextRequest
  requestId: string
  timeoutMs: number
  selectedModel: ModelType
  openAiApiKey: string
  exaApiKey?: string
  userTimeZone?: string
  userId?: string
  featureFlags?: AgentFeatureFlags
  messages: AgentStreamRequest["messages"]
  systemInstruction: string
  // Vector stores over the request's PDF attachments (goblins hosted tools).
  vectorStoreIds?: string[]
}

export function resolveUserTimeZone(request: NextRequest): string | undefined {
  const candidate = request.headers.get("x-user-timezone")?.trim()
  if (!candidate) {
    return undefined
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: candidate,
    }).format(new Date())
    return candidate
  } catch {
    return undefined
  }
}

export function resolveRequestId(request: NextRequest): string {
  return resolveRequestIdFromHeaders(request.headers)
}

function createTimeoutAbortSignal(
  request: NextRequest,
  timeoutMs: number
): AbortSignal {
  if (
    typeof AbortSignal.any === "function" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("Timed out", "AbortError"))
  }, timeoutMs)

  if (request.signal.aborted) {
    controller.abort(request.signal.reason)
  } else {
    request.signal.addEventListener(
      "abort",
      () => {
        controller.abort(request.signal.reason)
      },
      { once: true }
    )
  }

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timeoutId)
    },
    { once: true }
  )

  return controller.signal
}

function textDeltaEvent(delta: string): AgentStreamEvent {
  return { type: "text_delta", delta }
}

function isProviderAuthenticationError(error: unknown): boolean {
  const record = asRecord(error)
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : undefined
  if (status === 401 || status === 403) {
    return true
  }

  const code = asString(record?.code)?.toLowerCase()
  if (code === "invalid_api_key") {
    return true
  }

  const message =
    asString(record?.message)?.toLowerCase() ??
    (error instanceof Error ? error.message.toLowerCase() : "")

  return message.includes("api key")
}

function isTimeoutLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true
  }

  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    if (isAbortError(current)) {
      return true
    }

    const record = asRecord(current)
    const code = asString(record?.code)?.toUpperCase()
    if (code && TIMEOUT_ERROR_CODES.has(code)) {
      return true
    }

    const name = asString(record?.name)
    if (name && TIMEOUT_ERROR_NAMES.has(name)) {
      return true
    }

    const message =
      asString(record?.message)?.toLowerCase() ??
      (current instanceof Error ? current.message.toLowerCase() : "")
    if (
      message.includes("body timeout") ||
      message.includes("client-side timeout") ||
      message.includes("headers timeout")
    ) {
      return true
    }

    current = record?.cause
  }

  return false
}

function isSupportedModel(model: unknown): model is ModelType {
  return (
    typeof model === "string" &&
    // "goblins" is a selectable virtual mode, not part of ALL_MODELS (the real
    // callable models), so it is accepted explicitly here.
    ((ALL_MODELS as readonly string[]).includes(model) || isGoblinsModel(model))
  )
}

function isAvailableModel(
  models: readonly Pick<ModelInfo, "id">[],
  targetModel: ModelType
): boolean {
  const availableModelIds: readonly string[] = models.map((model) => model.id)
  return availableModelIds.includes(targetModel)
}

function getTotalMessageChars(
  messages: AgentStreamRequest["messages"]
): number {
  return messages.reduce((total, message) => total + message.content.length, 0)
}

export function createJsonErrorResponse(params: JsonErrorResponseParams) {
  const headers = createApiHeaders({
    requestId: params.requestId,
  })
  headers.set("X-Error-Code", params.errorCode)

  return Response.json(createApiErrorBody(params), {
    status: params.status,
    headers,
  })
}

export function parseAgentStreamRequest(
  params: ParseAgentStreamRequestParams
): Response | ParsedAgentStreamRequest {
  const parsed = agentStreamRequestSchema.safeParse(params.body)

  if (!parsed.success) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Invalid request payload.",
      errorCode: "AGENT_INVALID_REQUEST",
      status: 400,
    })
  }

  if (parsed.data.messages.length > AGENT_MAX_MESSAGES) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Conversation has too many messages.",
      errorCode: "AGENT_TOO_MANY_MESSAGES",
      status: 400,
    })
  }

  const oversizedMessage = parsed.data.messages.find(
    (message) => message.content.length > AGENT_MAX_MESSAGE_CHARS
  )
  if (oversizedMessage) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "A conversation message is too large.",
      errorCode: "AGENT_MESSAGE_TOO_LARGE",
      status: 413,
    })
  }

  const totalMessageChars = getTotalMessageChars(parsed.data.messages)
  if (totalMessageChars > AGENT_MAX_TOTAL_CHARS) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Conversation payload is too large.",
      errorCode: "AGENT_PAYLOAD_TOO_LARGE",
      status: 413,
    })
  }

  const lastMessage = parsed.data.messages[parsed.data.messages.length - 1]
  if (lastMessage?.role !== "user") {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "The final message must be from the user.",
      errorCode: "AGENT_FINAL_MESSAGE_INVALID",
      status: 400,
    })
  }

  const availableModelIds = new Set(
    params.availableModels.map((model) => model.id)
  )
  const chatModels = MODEL_SELECTOR_MODELS.flatMap((modelId) =>
    availableModelIds.has(modelId) ? [{ id: modelId }] : []
  )
  const selectedModelCandidate =
    parsed.data.model ?? resolveDefaultModelSelectorModel(chatModels)

  if (!isSupportedModel(selectedModelCandidate)) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Unsupported model selected.",
      errorCode: "AGENT_UNSUPPORTED_MODEL",
      status: 400,
    })
  }

  if (!isAvailableModel(chatModels, selectedModelCandidate)) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Unsupported model selected.",
      errorCode: "AGENT_UNSUPPORTED_MODEL",
      status: 400,
    })
  }

  return {
    parsedRequest: parsed.data,
    selectedModel: selectedModelCandidate,
  }
}

export function createAgentStreamResponse(
  params: CreateAgentStreamResponseParams
): Response {
  const logger = createLogger(`agent:${params.requestId}`)
  const streamSignal = createTimeoutAbortSignal(
    params.request,
    params.timeoutMs
  )
  const startedAt = Date.now()

  const encoder = new TextEncoder()
  let streamClosed = false
  const textStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamState = {
        hasTextChunk: false,
        hasMeaningfulText: false,
        hasStructuredOutput: false,
        hasToolOutput: false,
        sawTerminalAgentStatus: false,
        textChunkCount: 0,
        textCharCount: 0,
        sourceCount: 0,
        toolOutputCount: 0,
        toolErrorCount: 0,
        toolCallIds: new Set<string>(),
        completedToolCallIds: new Set<string>(),
      }
      let streamOutcome = "completed"

      const closeController = () => {
        if (streamClosed) {
          return
        }

        streamClosed = true
        try {
          controller.close()
        } catch {}
      }

      const enqueueEvent = (event: AgentStreamEvent) => {
        if (streamClosed) {
          return
        }

        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          streamClosed = true
        }
      }

      const enqueueTimeoutFallback = () => {
        const prefix = streamState.hasTextChunk ? "\n\n" : ""
        const fallbackText = `${prefix}${STREAM_TIMEOUT_FALLBACK_TEXT}`
        streamState.hasTextChunk = true
        streamState.hasMeaningfulText = true
        streamState.textChunkCount += 1
        streamState.textCharCount += fallbackText.length
        enqueueEvent(textDeltaEvent(fallbackText))
      }

      const getUnresolvedToolCallCount = () =>
        [...streamState.toolCallIds].filter(
          (callId) => !streamState.completedToolCallIds.has(callId)
        ).length

      try {
        const handleEvent = (event: AgentStreamEvent) => {
          if (event.type === "text_delta") {
            streamState.hasTextChunk = true
            streamState.textChunkCount += 1
            streamState.textCharCount += event.delta.length
            if (event.delta.trim().length > 0) {
              streamState.hasMeaningfulText = true
            }
          } else if (event.type !== "agent_status") {
            streamState.hasStructuredOutput = true
            if (event.type === "source") {
              streamState.sourceCount += 1
            }
            if (event.type === "tool_call" && event.callId) {
              streamState.toolCallIds.add(event.callId)
            }

            if (event.type === "tool_result") {
              streamState.hasToolOutput = true
              streamState.toolOutputCount += 1
              if (event.callId) {
                streamState.completedToolCallIds.add(event.callId)
              }
              if (event.status === "error") {
                streamState.toolErrorCount += 1
              }
            }
          }

          if (event.type === "agent_status" && event.status !== "in_progress") {
            streamState.sawTerminalAgentStatus = true
          }

          enqueueEvent(event)
        }

        handleEvent({ type: "agent_status", status: "in_progress" })

        const stream = startGatewayResponseStream({
          requestId: params.requestId,
          model: params.selectedModel,
          openAiApiKey: params.openAiApiKey,
          exaApiKey: params.exaApiKey,
          userTimeZone: params.userTimeZone,
          userId: params.userId,
          featureFlags: params.featureFlags,
          messages: params.messages,
          systemInstruction: withAiSdkInlineCitationInstruction(
            params.systemInstruction
          ),
          signal: streamSignal,
          vectorStoreIds: params.vectorStoreIds,
        })

        for await (const event of stream) {
          handleEvent(event)
        }

        const unresolvedToolCallCount = getUnresolvedToolCallCount()
        const hasUnresolvedToolCalls = unresolvedToolCallCount > 0
        const completedWithoutAnswer = !streamState.hasMeaningfulText
        const completedWithUnresolvedToolCall =
          !completedWithoutAnswer && hasUnresolvedToolCalls
        if (completedWithoutAnswer || completedWithUnresolvedToolCall) {
          const fallbackText = streamState.hasStructuredOutput
            ? streamState.hasToolOutput
              ? TOOL_OUTPUT_ONLY_FALLBACK_TEXT
              : hasUnresolvedToolCalls
                ? TOOL_CALL_INCOMPLETE_FALLBACK_TEXT
                : STRUCTURED_OUTPUT_ONLY_FALLBACK_TEXT
            : ASSISTANT_EMPTY_RESPONSE_FALLBACK
          streamOutcome = streamState.hasStructuredOutput
            ? "incomplete"
            : streamOutcome
          const prefix = streamState.hasTextChunk ? "\n\n" : ""
          const delta = completedWithUnresolvedToolCall
            ? `${prefix}${TOOL_CALL_INCOMPLETE_FALLBACK_TEXT}`
            : fallbackText
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          streamState.textChunkCount += 1
          streamState.textCharCount += delta.length
          enqueueEvent(textDeltaEvent(delta))
        }

        if (!streamState.sawTerminalAgentStatus) {
          handleEvent({
            type: "agent_status",
            status:
              (completedWithoutAnswer || completedWithUnresolvedToolCall) &&
              streamState.hasStructuredOutput
                ? "incomplete"
                : "completed",
          })
        }
      } catch (streamError) {
        const clientAborted = params.request.signal.aborted
        const streamFailureDetails = {
          error: streamError,
          errorCode: "AGENT_STREAM_FAILED",
          requestId: params.requestId,
        }
        enqueueEvent({ type: "agent_status", status: "failed" })

        if (isTimeoutLikeError(streamError)) {
          streamOutcome = clientAborted ? "client_aborted" : "timeout"
          if (!clientAborted) {
            logger.warn("Agent stream timed out before completion.", {
              error: streamError,
              errorCode: "AGENT_STREAM_TIMEOUT",
              requestId: params.requestId,
              timeoutMs: params.timeoutMs,
            })
          }

          if (!clientAborted) {
            enqueueTimeoutFallback()
          }
        } else if (
          isProviderAuthenticationError(streamError) &&
          !streamState.hasMeaningfulText
        ) {
          streamOutcome = "provider_auth_failed"
          logger.error("AI Gateway authentication failed.", {
            error: streamError,
            errorCode: "AGENT_PROVIDER_AUTH_FAILED",
            requestId: params.requestId,
          })
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          streamState.textChunkCount += 1
          streamState.textCharCount +=
            "Invalid OPENAI_API_KEY on the server.".length
          enqueueEvent(textDeltaEvent("Invalid OPENAI_API_KEY on the server."))
        } else if (!streamState.hasMeaningfulText) {
          streamOutcome = "failed"
          logger.error("Agent stream failed.", streamFailureDetails)
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          streamState.textChunkCount += 1
          streamState.textCharCount += STREAM_ERROR_FALLBACK_TEXT.length
          enqueueEvent(textDeltaEvent(STREAM_ERROR_FALLBACK_TEXT))
        } else if (!streamState.hasTextChunk) {
          streamOutcome = "failed"
          logger.error("Agent stream failed.", streamFailureDetails)
          streamState.hasTextChunk = true
          streamState.textChunkCount += 1
          streamState.textCharCount += ASSISTANT_EMPTY_RESPONSE_FALLBACK.length
          enqueueEvent(textDeltaEvent(ASSISTANT_EMPTY_RESPONSE_FALLBACK))
        } else {
          streamOutcome = "failed"
          logger.error("Agent stream failed.", streamFailureDetails)
        }
      } finally {
        logger.info("Agent stream settled.", {
          requestId: params.requestId,
          model: params.selectedModel,
          durationMs: Date.now() - startedAt,
          outcome: streamOutcome,
          hadMeaningfulText: streamState.hasMeaningfulText,
          hadStructuredOutput: streamState.hasStructuredOutput,
          textChunkCount: streamState.textChunkCount,
          textCharCount: streamState.textCharCount,
          sourceCount: streamState.sourceCount,
          toolOutputCount: streamState.toolOutputCount,
          toolErrorCount: streamState.toolErrorCount,
          unresolvedToolCallCount: getUnresolvedToolCallCount(),
        })
        closeController()
      }
    },
    cancel() {
      streamClosed = true
    },
  })

  const responseHeaders = createApiHeaders({
    requestId: params.requestId,
  })
  responseHeaders.set("Content-Type", "application/x-ndjson; charset=utf-8")
  responseHeaders.set("Cache-Control", "no-store, no-transform")
  responseHeaders.set("X-Agent-Effective-Model", params.selectedModel)

  return new Response(textStream, {
    headers: responseHeaders,
  })
}
