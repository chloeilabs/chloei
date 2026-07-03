import { type NextRequest } from "next/server"

import { getModels } from "@/lib/actions/api-keys"
import { createLogger } from "@/lib/logger"
import { buildAgentSystemInstruction } from "@/lib/server/agent-context"
import { resolvePromptProvider } from "@/lib/server/agent-prompt-steering"
import {
  createAgentStreamResponse,
  createJsonErrorResponse,
  parseAgentStreamRequest,
  resolveRequestId,
  resolveUserTimeZone,
} from "@/lib/server/agent-route"
import { AGENT_STREAM_TIMEOUT_MS } from "@/lib/server/agent-runtime-config"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  createE2eAgentStreamResponse,
  isE2eMockModeEnabled,
} from "@/lib/server/e2e-test-mode"
import { getExaApiKey, getOpenAiApiKey } from "@/lib/server/env"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"
import { resolveAttachmentFileIds } from "@/lib/server/llm/attachment-uploads"
import { ensureGoblinsVectorStore } from "@/lib/server/llm/vector-stores"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import { isThreadStoreNotInitializedError } from "@/lib/server/threads"
import { isGoblinsModel } from "@/lib/shared"

export const runtime = "nodejs"
export const maxDuration = 800

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const logger = createLogger(`agent:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/agent",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse({ "X-Request-Id": requestId }),
        {
          errorCode: "AUTH_UNAVAILABLE",
          outcome: "auth_unavailable",
        }
      )
    }

    const openAiApiKey = getOpenAiApiKey()
    const exaApiKey = getExaApiKey()
    const isE2eMockRequest = isE2eMockModeEnabled()
    const session = await getRequestSession(request.headers)

    if (!session) {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Unauthorized.",
          errorCode: "AGENT_UNAUTHORIZED",
          status: 401,
        }),
        {
          errorCode: "AGENT_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Invalid JSON payload.",
          errorCode: "AGENT_INVALID_JSON",
          status: 400,
        }),
        {
          errorCode: "AGENT_INVALID_JSON",
          outcome: "invalid_request",
        }
      )
    }

    const parsedRequestResult = parseAgentStreamRequest({
      body,
      availableModels: getModels(),
      requestId,
    })
    if (parsedRequestResult instanceof Response) {
      return observeRouteResponse(observation, parsedRequestResult, {
        errorCode: parsedRequestResult.headers.get("X-Error-Code") ?? undefined,
        outcome: "invalid_request",
      })
    }
    const { parsedRequest, selectedModel } = parsedRequestResult

    const requestNow = new Date()
    const userTimeZone = resolveUserTimeZone(request)
    const featureFlags = await resolveAgentFeatureFlags()
    const promptProvider = resolvePromptProvider(selectedModel)
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
      }
    )

    if (isE2eMockRequest) {
      return observeRouteResponse(
        observation,
        createE2eAgentStreamResponse({ requestId }),
        {
          outcome: "stream_started",
        }
      )
    }

    if (!openAiApiKey) {
      logger.error("Missing OPENAI_API_KEY on the server.", {
        errorCode: "AGENT_OPENAI_API_KEY_MISSING",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: "Missing OPENAI_API_KEY on the server.",
          errorCode: "AGENT_OPENAI_API_KEY_MISSING",
          status: 500,
        }),
        {
          errorCode: "AGENT_OPENAI_API_KEY_MISSING",
          outcome: "error",
        }
      )
    }

    // Upload any new base64 attachments to the Files API once, mutating the
    // request messages to reference them by fileId (smaller model request,
    // prompt-cacheable across turns). The returned map is echoed to the client
    // so it can persist and resend fileIds instead of base64 next turn.
    const attachmentFileIds = await resolveAttachmentFileIds({
      openAiApiKey,
      messages: parsedRequest.messages,
      requestId,
    })

    // Goblins hosted tools: give file_search-enabled goblins access to the
    // conversation's PDF attachments via a per-request vector store. Failure
    // degrades to no file_search (the manager still sees the files inline).
    let vectorStoreId: string | null = null
    if (isGoblinsModel(selectedModel) && featureFlags.goblinsHostedTools) {
      const pdfFileIds = [
        ...new Set(
          parsedRequest.messages.flatMap(
            (message) =>
              message.attachments?.flatMap((attachment) =>
                attachment.kind === "pdf" && attachment.fileId
                  ? [attachment.fileId]
                  : []
              ) ?? []
          )
        ),
      ]
      vectorStoreId = await ensureGoblinsVectorStore({
        openAiApiKey,
        fileIds: pdfFileIds,
        requestId,
      })
    }

    const streamResponse = createAgentStreamResponse({
      request,
      requestId,
      timeoutMs: AGENT_STREAM_TIMEOUT_MS,
      selectedModel,
      openAiApiKey,
      exaApiKey,
      userTimeZone,
      userId: session.user.id,
      featureFlags,
      messages: parsedRequest.messages,
      systemInstruction,
      ...(vectorStoreId ? { vectorStoreIds: [vectorStoreId] } : {}),
    })
    if (Object.keys(attachmentFileIds).length > 0) {
      streamResponse.headers.set(
        "X-Attachment-File-Ids",
        JSON.stringify(attachmentFileIds)
      )
    }
    if (vectorStoreId) {
      streamResponse.headers.set("X-Vector-Store-Id", vectorStoreId)
    }

    return observeRouteResponse(observation, streamResponse, {
      outcome: "stream_started",
    })
  } catch (error) {
    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createJsonErrorResponse({
          requestId,
          error: error.message,
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          status: 500,
        }),
        {
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          outcome: "error",
        }
      )
    }

    logger.error("Agent request failed.", {
      error,
      errorCode: "AGENT_REQUEST_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createJsonErrorResponse({
        requestId,
        error: "Failed to generate agent response.",
        errorCode: "AGENT_REQUEST_FAILED",
        status: 500,
      }),
      {
        errorCode: "AGENT_REQUEST_FAILED",
        outcome: "error",
      }
    )
  }
}
