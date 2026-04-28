import { Buffer } from "node:buffer"

import { type NextRequest } from "next/server"
import { z } from "zod"

import { asRecord, asString, isAbortError } from "@/lib/cast"
import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  AGENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  AGENT_ATTACHMENT_MAX_FILE_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  AGENT_ATTACHMENT_MIME_TYPES,
  AGENT_IMAGE_DETAIL_VALUES,
  AGENT_RUN_MODES,
  type AgentRunMode,
  type AgentStreamEvent,
  ALL_MODELS,
  AvailableModels,
  getAgentAttachmentKind,
  getDataUrlMediaType,
  type ModelInfo,
  type ModelType,
  resolveDefaultModel,
} from "@/lib/shared"

import {
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_TOTAL_CHARS,
} from "./agent-runtime-config"
import { createApiErrorBody, createApiHeaders } from "./api-response"
import type { AgentRuntimeProfileId } from "./llm/agent-runtime"
import { startGatewayResponseStream } from "./llm/gateway-responses"
import { withAiSdkInlineCitationInstruction } from "./llm/system-instruction-augmentations"
import { type evaluateAndConsumeSlidingWindowRateLimit } from "./rate-limit"

const STREAM_TIMEOUT_FALLBACK_TEXT =
  "Sorry, I couldn't finish the response in time. Please retry."
const STREAM_ERROR_FALLBACK_TEXT =
  "Sorry, I hit an error while generating a response. Please retry."
const STRUCTURED_OUTPUT_ONLY_FALLBACK_TEXT =
  "I produced intermediate output, but the model ended before writing a final answer. Please retry or narrow the request."
const TOOL_OUTPUT_ONLY_FALLBACK_TEXT =
  "I gathered tool results, but the model ended before writing a final answer. Please retry or narrow the request; the tool output above is still available for inspection."

const DATA_URL_BASE64_PREFIX_PATTERN = /^data:([^;,]+);base64,/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const agentAttachmentSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["image", "pdf"]),
    filename: z.string().trim().min(1).max(500),
    mediaType: z.enum(AGENT_ATTACHMENT_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(AGENT_ATTACHMENT_MAX_FILE_BYTES),
    detail: z.enum(AGENT_IMAGE_DETAIL_VALUES).optional(),
    previewDataUrl: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS)
      .optional(),
    dataUrl: z.string().trim().min(1).max(AGENT_ATTACHMENT_MAX_DATA_URL_CHARS),
  })
  .strict()

const agentMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1),
    attachments: z.array(agentAttachmentSchema).optional(),
  })
  .strict()

export const agentStreamRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    runMode: z.enum(AGENT_RUN_MODES).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    messages: z.array(agentMessageSchema).min(1),
  })
  .strict()

type AgentStreamRequest = z.infer<typeof agentStreamRequestSchema>
type ParsedAgentStreamRequestData = Omit<AgentStreamRequest, "runMode"> & {
  runMode: AgentRunMode
}
type AgentRateLimitDecision = ReturnType<
  typeof evaluateAndConsumeSlidingWindowRateLimit
>
interface ParsedAgentStreamRequest {
  parsedRequest: ParsedAgentStreamRequestData
  selectedModel: ModelType
}

interface JsonErrorResponseParams {
  requestId: string
  error: string
  errorCode: string
  status: number
  rateLimitDecision?: AgentRateLimitDecision
  retryAfterSeconds?: number | null
}

interface ParseAgentStreamRequestParams {
  body: unknown
  availableModels: readonly Pick<ModelInfo, "id">[]
  requestId: string
  rateLimitDecision?: AgentRateLimitDecision
}

interface CreateAgentStreamResponseParams {
  request: NextRequest
  requestId: string
  rateLimitDecision?: AgentRateLimitDecision
  timeoutMs: number
  selectedModel: ModelType
  aiGatewayApiKey: string
  tavilyApiKey?: string
  fmpApiKey?: string
  userTimeZone?: string
  runtimeProfile?: AgentRuntimeProfileId
  messages: AgentStreamRequest["messages"]
  systemInstruction: string
  onStreamSettled?: () => void
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

function isSupportedModel(model: unknown): model is ModelType {
  return (
    typeof model === "string" &&
    (ALL_MODELS as readonly string[]).includes(model)
  )
}

function isAvailableModel(
  models: readonly Pick<ModelInfo, "id">[],
  targetModel: ModelType
): boolean {
  return models.some((model) => model.id === targetModel)
}

function getTotalMessageChars(
  messages: AgentStreamRequest["messages"]
): number {
  return messages.reduce((total, message) => total + message.content.length, 0)
}

function getMessageAttachments(messages: AgentStreamRequest["messages"]) {
  return messages.flatMap((message) => message.attachments ?? [])
}

function hasMessageAttachments(messages: AgentStreamRequest["messages"]) {
  return messages.some((message) => (message.attachments?.length ?? 0) > 0)
}

function getTotalAttachmentBytes(
  attachments: readonly { sizeBytes: number }[]
): number {
  return attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0
  )
}

function getBase64Payload(dataUrl: string): string | null {
  const match = DATA_URL_BASE64_PREFIX_PATTERN.exec(dataUrl)
  if (!match) {
    return null
  }

  return dataUrl.slice(match[0].length)
}

function normalizeBase64Payload(value: string): string | null {
  const normalized = value.replace(/\s/g, "")
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    return null
  }

  if (!BASE64_PATTERN.test(normalized)) {
    return null
  }

  try {
    const decoded = Buffer.from(normalized, "base64")
    return decoded.length > 0 && decoded.toString("base64") === normalized
      ? normalized
      : null
  } catch {
    return null
  }
}

function isValidBase64Payload(value: string): boolean {
  return normalizeBase64Payload(value) !== null
}

function createAttachmentValidationError(params: {
  requestId: string
  rateLimitDecision?: AgentRateLimitDecision
}) {
  return createJsonErrorResponse({
    requestId: params.requestId,
    error: "Invalid file attachment payload.",
    errorCode: "AGENT_ATTACHMENT_INVALID",
    status: 400,
    rateLimitDecision: params.rateLimitDecision,
  })
}

function validateAgentRequestAttachments(
  params: Pick<
    ParseAgentStreamRequestParams,
    "requestId" | "rateLimitDecision"
  > & {
    messages: AgentStreamRequest["messages"]
  }
): Response | null {
  const attachments = getMessageAttachments(params.messages)
  if (attachments.length === 0) {
    return null
  }

  for (const message of params.messages) {
    const messageAttachments = message.attachments ?? []

    if (messageAttachments.length > 0 && message.role !== "user") {
      return createJsonErrorResponse({
        requestId: params.requestId,
        error: "Only user messages can include file attachments.",
        errorCode: "AGENT_ATTACHMENT_ROLE_INVALID",
        status: 400,
        rateLimitDecision: params.rateLimitDecision,
      })
    }

    if (
      message.role === "user" &&
      messageAttachments.length > AGENT_ATTACHMENT_MAX_FILES
    ) {
      return createJsonErrorResponse({
        requestId: params.requestId,
        error: "Too many file attachments.",
        errorCode: "AGENT_TOO_MANY_ATTACHMENTS",
        status: 400,
        rateLimitDecision: params.rateLimitDecision,
      })
    }

    if (
      message.role === "user" &&
      getTotalAttachmentBytes(messageAttachments) >
        AGENT_ATTACHMENT_MAX_TOTAL_BYTES
    ) {
      return createJsonErrorResponse({
        requestId: params.requestId,
        error: "Attached files are too large.",
        errorCode: "AGENT_ATTACHMENTS_TOO_LARGE",
        status: 413,
        rateLimitDecision: params.rateLimitDecision,
      })
    }
  }

  if (attachments.length > AGENT_ATTACHMENT_MAX_FILES) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Too many file attachments.",
      errorCode: "AGENT_TOO_MANY_ATTACHMENTS",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  if (getTotalAttachmentBytes(attachments) > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Attached files are too large.",
      errorCode: "AGENT_ATTACHMENTS_TOO_LARGE",
      status: 413,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  for (const message of params.messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== getAgentAttachmentKind(attachment.mediaType)) {
        return createAttachmentValidationError(params)
      }

      if (attachment.kind !== "image" && attachment.detail) {
        return createAttachmentValidationError(params)
      }

      if (getDataUrlMediaType(attachment.dataUrl) !== attachment.mediaType) {
        return createAttachmentValidationError(params)
      }

      const base64Payload = getBase64Payload(attachment.dataUrl)
      const normalizedBase64Payload = base64Payload
        ? normalizeBase64Payload(base64Payload)
        : null
      if (
        !normalizedBase64Payload ||
        !isValidBase64Payload(normalizedBase64Payload)
      ) {
        return createAttachmentValidationError(params)
      }

      if (
        Buffer.byteLength(normalizedBase64Payload, "base64") !==
        attachment.sizeBytes
      ) {
        return createAttachmentValidationError(params)
      }
    }
  }

  return null
}

function applyRateLimitHeaders(
  headers: Headers,
  rateLimitDecision: AgentRateLimitDecision
) {
  headers.set("X-RateLimit-Limit", String(rateLimitDecision.limit))
  headers.set("X-RateLimit-Remaining", String(rateLimitDecision.remaining))
  headers.set(
    "X-RateLimit-Reset",
    String(rateLimitDecision.resetAtEpochSeconds)
  )
}

export function createJsonErrorResponse(params: JsonErrorResponseParams) {
  const headers = createApiHeaders({
    requestId: params.requestId,
  })
  headers.set("X-Error-Code", params.errorCode)
  if (params.rateLimitDecision) {
    applyRateLimitHeaders(headers, params.rateLimitDecision)
  }
  if (params.retryAfterSeconds && params.retryAfterSeconds > 0) {
    headers.set("Retry-After", String(params.retryAfterSeconds))
  }

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
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  if (parsed.data.messages.length > AGENT_MAX_MESSAGES) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Conversation has too many messages.",
      errorCode: "AGENT_TOO_MANY_MESSAGES",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
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
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const totalMessageChars = getTotalMessageChars(parsed.data.messages)
  if (totalMessageChars > AGENT_MAX_TOTAL_CHARS) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Conversation payload is too large.",
      errorCode: "AGENT_PAYLOAD_TOO_LARGE",
      status: 413,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const attachmentValidationError = validateAgentRequestAttachments({
    messages: parsed.data.messages,
    requestId: params.requestId,
    rateLimitDecision: params.rateLimitDecision,
  })
  if (attachmentValidationError) {
    return attachmentValidationError
  }

  const lastMessage = parsed.data.messages[parsed.data.messages.length - 1]
  if (lastMessage?.role !== "user") {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "The final message must be from the user.",
      errorCode: "AGENT_FINAL_MESSAGE_INVALID",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const runMode = parsed.data.runMode ?? "chat"

  if (
    runMode === "research" &&
    !isAvailableModel(params.availableModels, AvailableModels.OPENAI_GPT_5_5)
  ) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Research mode requires GPT-5.5 model access.",
      errorCode: "AGENT_RESEARCH_MODEL_UNAVAILABLE",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  if (
    hasMessageAttachments(parsed.data.messages) &&
    !isAvailableModel(params.availableModels, AvailableModels.OPENAI_GPT_5_5)
  ) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "File attachments require GPT-5.5 model access.",
      errorCode: "AGENT_ATTACHMENT_MODEL_UNAVAILABLE",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const selectedModelCandidate =
    runMode === "research" || hasMessageAttachments(parsed.data.messages)
      ? AvailableModels.OPENAI_GPT_5_5
      : (parsed.data.model ?? resolveDefaultModel(params.availableModels))

  if (!isSupportedModel(selectedModelCandidate)) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Unsupported model selected.",
      errorCode: "AGENT_UNSUPPORTED_MODEL",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  return {
    parsedRequest: {
      ...parsed.data,
      runMode,
    },
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
  let streamSettled = false
  const settleStream = () => {
    if (streamSettled) {
      return
    }

    streamSettled = true
    params.onStreamSettled?.()
  }

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

      try {
        const handleEvent = (event: AgentStreamEvent) => {
          if (event.type === "text_delta") {
            streamState.hasTextChunk = true
            if (event.delta.trim().length > 0) {
              streamState.hasMeaningfulText = true
            }
          } else if (event.type !== "agent_status") {
            streamState.hasStructuredOutput = true
            if (event.type === "tool_call" || event.type === "tool_result") {
              streamState.hasToolOutput = true
            }
          }

          if (event.type === "agent_status" && event.status !== "in_progress") {
            streamState.sawTerminalAgentStatus = true
          }

          enqueueEvent(event)
        }

        handleEvent({ type: "agent_status", status: "in_progress" })

        const stream = startGatewayResponseStream({
          model: params.selectedModel,
          aiGatewayApiKey: params.aiGatewayApiKey,
          tavilyApiKey: params.tavilyApiKey,
          fmpApiKey: params.fmpApiKey,
          userTimeZone: params.userTimeZone,
          runtimeProfile: params.runtimeProfile,
          messages: params.messages,
          systemInstruction: withAiSdkInlineCitationInstruction(
            params.systemInstruction,
            {
              fmpEnabled: Boolean(params.fmpApiKey?.trim()),
            }
          ),
          signal: streamSignal,
        })

        for await (const event of stream) {
          handleEvent(event)
        }

        const completedWithoutAnswer = !streamState.hasMeaningfulText
        if (completedWithoutAnswer) {
          streamOutcome = streamState.hasStructuredOutput
            ? "incomplete"
            : streamOutcome
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          enqueueEvent(
            textDeltaEvent(
              streamState.hasStructuredOutput
                ? streamState.hasToolOutput
                  ? TOOL_OUTPUT_ONLY_FALLBACK_TEXT
                  : STRUCTURED_OUTPUT_ONLY_FALLBACK_TEXT
                : ASSISTANT_EMPTY_RESPONSE_FALLBACK
            )
          )
        }

        if (!streamState.sawTerminalAgentStatus) {
          handleEvent({
            type: "agent_status",
            status:
              completedWithoutAnswer && streamState.hasStructuredOutput
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

        if (isAbortError(streamError)) {
          streamOutcome = clientAborted ? "client_aborted" : "timeout"
          if (!clientAborted) {
            logger.warn(
              `Agent stream aborted after ${String(params.timeoutMs)}ms timeout.`,
              {
                errorCode: "AGENT_STREAM_TIMEOUT",
                requestId: params.requestId,
                timeoutMs: params.timeoutMs,
              }
            )
          }

          if (!clientAborted && !streamState.hasMeaningfulText) {
            streamState.hasTextChunk = true
            streamState.hasMeaningfulText = true
            enqueueEvent(textDeltaEvent(STREAM_TIMEOUT_FALLBACK_TEXT))
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
          enqueueEvent(
            textDeltaEvent("Invalid AI_GATEWAY_API_KEY on the server.")
          )
        } else if (!streamState.hasMeaningfulText) {
          streamOutcome = "failed"
          logger.error("Agent stream failed.", streamFailureDetails)
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          enqueueEvent(textDeltaEvent(STREAM_ERROR_FALLBACK_TEXT))
        } else if (!streamState.hasTextChunk) {
          streamOutcome = "failed"
          logger.error("Agent stream failed.", streamFailureDetails)
          streamState.hasTextChunk = true
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
        })
        settleStream()
        closeController()
      }
    },
    cancel() {
      streamClosed = true
      settleStream()
    },
  })

  const responseHeaders = createApiHeaders({
    requestId: params.requestId,
  })
  responseHeaders.set("Content-Type", "application/x-ndjson; charset=utf-8")
  responseHeaders.set("Cache-Control", "no-store, no-transform")
  if (params.rateLimitDecision) {
    applyRateLimitHeaders(responseHeaders, params.rateLimitDecision)
  }

  return new Response(textStream, {
    headers: responseHeaders,
  })
}
