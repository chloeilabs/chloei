import { type NextRequest } from "next/server"
import { z } from "zod"

import { asRecord, asString, isAbortError } from "@/lib/cast"
import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import { createLogger } from "@/lib/logger"
import {
  type AgentStreamEvent,
  ALL_MODELS,
  type ModelInfo,
  type ModelType,
  OPENROUTER_MODELS,
  resolveDefaultModel,
} from "@/lib/shared"

import {
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_TOTAL_CHARS,
} from "./agent-runtime-config"
import { startOpenRouterResponseStream } from "./llm/openrouter-responses"
import { withAiSdkInlineCitationInstruction } from "./llm/system-instruction-augmentations"
import { type evaluateAndConsumeSlidingWindowRateLimit } from "./rate-limit"

const STREAM_TIMEOUT_FALLBACK_TEXT =
  "Sorry, I couldn't finish the response in time. Please retry."
const STREAM_ERROR_FALLBACK_TEXT =
  "Sorry, I hit an error while generating a response. Please retry."

const allowedModels = ALL_MODELS

const agentMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(AGENT_MAX_MESSAGE_CHARS),
  })
  .strict()

export const agentStreamRequestSchema = z
  .object({
    model: z.enum(allowedModels).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    messages: z.array(agentMessageSchema).min(1).max(AGENT_MAX_MESSAGES),
  })
  .strict()

type AgentStreamRequest = z.infer<typeof agentStreamRequestSchema>
type AgentRateLimitDecision = ReturnType<
  typeof evaluateAndConsumeSlidingWindowRateLimit
>

interface ParsedAgentStreamRequest {
  parsedRequest: AgentStreamRequest
  selectedModel: ModelType
}

interface JsonErrorResponseParams {
  requestId: string
  error: string
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
  openRouterApiKey: string
  tavilyApiKey?: string
  fmpApiKey?: string
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
  const incomingRequestId = request.headers.get("x-request-id")?.trim()
  if (incomingRequestId) {
    return incomingRequestId
  }

  return crypto.randomUUID()
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

function isOpenRouterModel(model: ModelType): boolean {
  return (OPENROUTER_MODELS as readonly ModelType[]).includes(model)
}

function getTotalMessageChars(messages: AgentStreamRequest["messages"]): number {
  return messages.reduce((total, message) => total + message.content.length, 0)
}

function createBaseHeaders(requestId: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  })
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
  const headers = createBaseHeaders(params.requestId)
  if (params.rateLimitDecision) {
    applyRateLimitHeaders(headers, params.rateLimitDecision)
  }
  if (params.retryAfterSeconds && params.retryAfterSeconds > 0) {
    headers.set("Retry-After", String(params.retryAfterSeconds))
  }

  return Response.json(
    { error: params.error },
    {
      status: params.status,
      headers,
    }
  )
}

export function parseAgentStreamRequest(
  params: ParseAgentStreamRequestParams
): Response | ParsedAgentStreamRequest {
  const parsed = agentStreamRequestSchema.safeParse(params.body)

  if (!parsed.success) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Invalid request payload.",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const totalMessageChars = getTotalMessageChars(parsed.data.messages)
  if (totalMessageChars > AGENT_MAX_TOTAL_CHARS) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Conversation payload is too large.",
      status: 413,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const lastMessage = parsed.data.messages[parsed.data.messages.length - 1]
  if (lastMessage?.role !== "user") {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "The final message must be from the user.",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  const selectedModel =
    parsed.data.model ?? resolveDefaultModel(params.availableModels)

  if (!isOpenRouterModel(selectedModel)) {
    return createJsonErrorResponse({
      requestId: params.requestId,
      error: "Unsupported model selected.",
      status: 400,
      rateLimitDecision: params.rateLimitDecision,
    })
  }

  return {
    parsedRequest: parsed.data,
    selectedModel,
  }
}

export function createAgentStreamResponse(
  params: CreateAgentStreamResponseParams
): Response {
  const logger = createLogger(`agent:${params.requestId}`)
  const streamSignal = createTimeoutAbortSignal(params.request, params.timeoutMs)
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
        sawTerminalAgentStatus: false,
      }

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
          }

          if (
            event.type === "agent_status" &&
            event.status !== "in_progress"
          ) {
            streamState.sawTerminalAgentStatus = true
          }

          enqueueEvent(event)
        }

        handleEvent({ type: "agent_status", status: "in_progress" })

        const stream = startOpenRouterResponseStream({
          model: params.selectedModel,
          openRouterApiKey: params.openRouterApiKey,
          tavilyApiKey: params.tavilyApiKey,
          fmpApiKey: params.fmpApiKey,
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

        if (!streamState.sawTerminalAgentStatus) {
          handleEvent({ type: "agent_status", status: "completed" })
        }

        if (!streamState.hasMeaningfulText && !streamState.hasStructuredOutput) {
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          enqueueEvent(textDeltaEvent(ASSISTANT_EMPTY_RESPONSE_FALLBACK))
        }
      } catch (streamError) {
        const clientAborted = params.request.signal.aborted
        enqueueEvent({ type: "agent_status", status: "failed" })

        if (isAbortError(streamError)) {
          if (!clientAborted) {
            logger.warn(
              `Agent stream aborted after ${String(params.timeoutMs)}ms timeout.`
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
          logger.error("OpenRouter authentication failed.", streamError)
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          enqueueEvent(
            textDeltaEvent("Invalid OPENROUTER_API_KEY on the server.")
          )
        } else if (!streamState.hasMeaningfulText) {
          logger.error("Agent stream failed.", streamError)
          streamState.hasTextChunk = true
          streamState.hasMeaningfulText = true
          enqueueEvent(textDeltaEvent(STREAM_ERROR_FALLBACK_TEXT))
        } else if (!streamState.hasTextChunk) {
          logger.error("Agent stream failed.", streamError)
          streamState.hasTextChunk = true
          enqueueEvent(textDeltaEvent(ASSISTANT_EMPTY_RESPONSE_FALLBACK))
        } else {
          logger.error("Agent stream failed.", streamError)
        }
      } finally {
        settleStream()
        closeController()
      }
    },
    cancel() {
      streamClosed = true
      settleStream()
    },
  })

  const responseHeaders = createBaseHeaders(params.requestId)
  responseHeaders.set("Content-Type", "application/x-ndjson; charset=utf-8")
  responseHeaders.set("Cache-Control", "no-store, no-transform")
  if (params.rateLimitDecision) {
    applyRateLimitHeaders(responseHeaders, params.rateLimitDecision)
  }

  return new Response(textStream, {
    headers: responseHeaders,
  })
}
