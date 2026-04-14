import { type NextRequest } from "next/server"
import { z } from "zod"

import { getModels } from "@/lib/actions/api-keys"
import { asRecord, asString, isAbortError } from "@/lib/cast"
import { ASSISTANT_EMPTY_RESPONSE_FALLBACK } from "@/lib/constants"
import { buildAgentSystemInstruction } from "@/lib/server/agent-context"
import {
  inferPromptTaskMode,
  resolvePromptProvider,
} from "@/lib/server/agent-prompt-steering"
import {
  AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_TOTAL_CHARS,
  AGENT_RATE_LIMIT_ENABLED,
  AGENT_RATE_LIMIT_MAX_REQUESTS,
  AGENT_RATE_LIMIT_WINDOW_MS,
  AGENT_STREAM_TIMEOUT_MS,
} from "@/lib/server/agent-runtime-config"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { startOpenRouterResponseStream } from "@/lib/server/llm/openrouter-responses"
import { withAiSdkInlineCitationInstruction } from "@/lib/server/llm/system-instruction-augmentations"
import {
  evaluateAndConsumeSlidingWindowRateLimit,
  tryAcquireConcurrencySlot,
} from "@/lib/server/rate-limit"
import { isThreadStoreNotInitializedError } from "@/lib/server/threads"
import {
  type AgentStreamEvent,
  ALL_MODELS,
  type ModelType,
  OPENROUTER_MODELS,
  resolveDefaultModel,
} from "@/lib/shared"

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

const agentStreamRequestSchema = z
  .object({
    model: z.enum(allowedModels).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    messages: z.array(agentMessageSchema).min(1).max(AGENT_MAX_MESSAGES),
  })
  .strict()

export const runtime = "nodejs"

type AgentRateLimitDecision = ReturnType<
  typeof evaluateAndConsumeSlidingWindowRateLimit
>

function resolveUserTimeZone(request: NextRequest): string | undefined {
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

function resolveRateLimitIdentifier(userId: string): string {
  return `user:${userId}`
}

function resolveRequestId(request: NextRequest): string {
  const incomingRequestId = request.headers.get("x-request-id")?.trim()
  if (incomingRequestId) {
    return incomingRequestId
  }

  return crypto.randomUUID()
}

function getTotalMessageChars(
  messages: z.infer<typeof agentStreamRequestSchema>["messages"]
): number {
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

function createJsonErrorResponse(params: {
  requestId: string
  error: string
  status: number
  rateLimitDecision?: AgentRateLimitDecision
  retryAfterSeconds?: number | null
}) {
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

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    if (!isAuthConfigured()) {
      return createAuthUnavailableResponse({ "X-Request-Id": requestId })
    }

    const openRouterApiKey = process.env.OPENROUTER_API_KEY
    const tavilyApiKey = process.env.TAVILY_API_KEY
    const fmpApiKey = process.env.FMP_API_KEY
    const session = await getRequestSession(request.headers)

    if (!session) {
      return createJsonErrorResponse({
        requestId,
        error: "Unauthorized.",
        status: 401,
      })
    }

    const clientIdentifier = resolveRateLimitIdentifier(session.user.id)
    const rateLimitDecision = AGENT_RATE_LIMIT_ENABLED
      ? evaluateAndConsumeSlidingWindowRateLimit({
          identifier: clientIdentifier,
          maxRequests: AGENT_RATE_LIMIT_MAX_REQUESTS,
          windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
        })
      : null

    if (rateLimitDecision && !rateLimitDecision.allowed) {
      return createJsonErrorResponse({
        requestId,
        error: "Too many requests. Please retry shortly.",
        status: 429,
        retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
        rateLimitDecision,
      })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return createJsonErrorResponse({
        requestId,
        error: "Invalid JSON payload.",
        status: 400,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const parsed = agentStreamRequestSchema.safeParse(body)

    if (!parsed.success) {
      return createJsonErrorResponse({
        requestId,
        error: "Invalid request payload.",
        status: 400,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const totalMessageChars = getTotalMessageChars(parsed.data.messages)
    if (totalMessageChars > AGENT_MAX_TOTAL_CHARS) {
      return createJsonErrorResponse({
        requestId,
        error: "Conversation payload is too large.",
        status: 413,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const lastMessage = parsed.data.messages[parsed.data.messages.length - 1]
    if (lastMessage?.role !== "user") {
      return createJsonErrorResponse({
        requestId,
        error: "The final message must be from the user.",
        status: 400,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const selectedModel: ModelType =
      parsed.data.model ?? resolveDefaultModel(getModels())
    const useOpenRouter = isOpenRouterModel(selectedModel)

    if (!useOpenRouter) {
      return createJsonErrorResponse({
        requestId,
        error: "Unsupported model selected.",
        status: 400,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const requestNow = new Date()
    const userTimeZone = resolveUserTimeZone(request)
    const promptProvider = resolvePromptProvider(selectedModel)
    const promptTaskMode = inferPromptTaskMode(parsed.data.messages)
    const systemInstruction = buildAgentSystemInstruction(
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      {
        now: requestNow,
        userTimeZone,
        provider: promptProvider,
        taskMode: promptTaskMode,
      }
    )

    if (!openRouterApiKey) {
      return createJsonErrorResponse({
        requestId,
        error: "Missing OPENROUTER_API_KEY on the server.",
        status: 500,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const concurrencySlot = AGENT_RATE_LIMIT_ENABLED
      ? tryAcquireConcurrencySlot({
          identifier: clientIdentifier,
          maxConcurrent: AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
          windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
        })
      : null

    if (concurrencySlot && !concurrencySlot.allowed) {
      return createJsonErrorResponse({
        requestId,
        error: "Too many concurrent requests. Please retry shortly.",
        status: 429,
        retryAfterSeconds: concurrencySlot.retryAfterSeconds,
        rateLimitDecision: rateLimitDecision ?? undefined,
      })
    }

    const streamSignal = createTimeoutAbortSignal(
      request,
      AGENT_STREAM_TIMEOUT_MS
    )
    let releasedConcurrencySlot = false
    const releaseConcurrencySlot = () => {
      if (releasedConcurrencySlot) {
        return
      }

      releasedConcurrencySlot = true
      concurrencySlot?.release()
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
            model: selectedModel,
            openRouterApiKey,
            tavilyApiKey,
            fmpApiKey,
            messages: parsed.data.messages,
            systemInstruction: withAiSdkInlineCitationInstruction(
              systemInstruction,
              {
                fmpEnabled: Boolean(fmpApiKey?.trim()),
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

          if (
            !streamState.hasMeaningfulText &&
            !streamState.hasStructuredOutput
          ) {
            streamState.hasTextChunk = true
            streamState.hasMeaningfulText = true
            enqueueEvent(textDeltaEvent(ASSISTANT_EMPTY_RESPONSE_FALLBACK))
          }
        } catch (streamError) {
          const clientAborted = request.signal.aborted
          enqueueEvent({ type: "agent_status", status: "failed" })

          if (isAbortError(streamError)) {
            if (!clientAborted) {
              console.warn(
                `[agent:${requestId}] Agent stream aborted after ${String(AGENT_STREAM_TIMEOUT_MS)}ms timeout.`
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
            console.error(
              `[agent:${requestId}] OpenRouter authentication failed:`,
              streamError
            )
            streamState.hasTextChunk = true
            streamState.hasMeaningfulText = true
            enqueueEvent(
              textDeltaEvent("Invalid OPENROUTER_API_KEY on the server.")
            )
          } else if (!streamState.hasMeaningfulText) {
            console.error(
              `[agent:${requestId}] Agent stream failed:`,
              streamError
            )
            streamState.hasTextChunk = true
            streamState.hasMeaningfulText = true
            enqueueEvent(textDeltaEvent(STREAM_ERROR_FALLBACK_TEXT))
          } else if (!streamState.hasTextChunk) {
            console.error(
              `[agent:${requestId}] Agent stream failed:`,
              streamError
            )
            streamState.hasTextChunk = true
            enqueueEvent(textDeltaEvent(ASSISTANT_EMPTY_RESPONSE_FALLBACK))
          } else {
            console.error(
              `[agent:${requestId}] Agent stream failed:`,
              streamError
            )
          }
        } finally {
          releaseConcurrencySlot()
          closeController()
        }
      },
      cancel() {
        streamClosed = true
        releaseConcurrencySlot()
      },
    })

    const responseHeaders = createBaseHeaders(requestId)
    responseHeaders.set("Content-Type", "application/x-ndjson; charset=utf-8")
    responseHeaders.set("Cache-Control", "no-store, no-transform")
    if (rateLimitDecision) {
      applyRateLimitHeaders(responseHeaders, rateLimitDecision)
    }

    return new Response(textStream, {
      headers: responseHeaders,
    })
  } catch (error) {
    if (isThreadStoreNotInitializedError(error)) {
      return createJsonErrorResponse({
        requestId,
        error: error.message,
        status: 500,
      })
    }

    console.error(`[agent:${requestId}] Agent request failed:`, error)
    return createJsonErrorResponse({
      requestId,
      error: "Failed to generate agent response.",
      status: 500,
    })
  }
}
