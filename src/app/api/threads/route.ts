import { type NextRequest, NextResponse } from "next/server"
import { z, ZodError } from "zod"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import { deleteLongTermMemoriesForThread } from "@/lib/server/long-term-memory"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import {
  deleteThreadForUser,
  getThreadForUser,
  isThreadStoreNotInitializedError,
  listThreadSummariesForUser,
  parseThreadPayload,
  upsertThreadForUser,
} from "@/lib/server/threads"

export const runtime = "nodejs"

const deleteThreadSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
  })
  .strict()
const threadIdSchema = z.string().trim().min(1).max(200)

function createHeaders(requestId: string) {
  return createApiHeaders({ requestId })
}

function createErrorResponse(
  requestId: string,
  error: string,
  errorCode: string,
  status: number
) {
  return createApiErrorResponse({
    requestId,
    error,
    errorCode,
    status,
  })
}

async function requireSession(request: NextRequest, requestId: string) {
  if (!isAuthConfigured()) {
    return createAuthUnavailableResponse(createHeaders(requestId))
  }

  const session = await getRequestSession(request.headers)

  if (!session) {
    return createErrorResponse(
      requestId,
      "Unauthorized.",
      "THREADS_UNAUTHORIZED",
      401
    )
  }

  return session
}

function getRequestedThreadId(request: NextRequest): string | null {
  const rawThreadId = request.nextUrl.searchParams.get("id")

  if (rawThreadId === null) {
    return null
  }

  return threadIdSchema.parse(rawThreadId)
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/threads",
  })

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return observeRouteResponse(observation, session, {
        errorCode: session.headers.get("X-Error-Code") ?? undefined,
        outcome: "request_rejected",
      })
    }

    const threadId = getRequestedThreadId(request)

    if (threadId) {
      const thread = await getThreadForUser(session.user.id, threadId)

      if (!thread) {
        return observeRouteResponse(
          observation,
          createErrorResponse(
            requestId,
            "Thread not found.",
            "THREAD_NOT_FOUND",
            404
          ),
          {
            errorCode: "THREAD_NOT_FOUND",
            outcome: "not_found",
          }
        )
      }

      return observeRouteResponse(
        observation,
        NextResponse.json(thread, {
          headers: createHeaders(requestId),
        }),
        {
          outcome: "success",
        }
      )
    }

    const threads = await listThreadSummariesForUser(session.user.id)

    return observeRouteResponse(
      observation,
      NextResponse.json(threads, {
        headers: createHeaders(requestId),
      }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    if (error instanceof ZodError) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid thread id.",
          "THREAD_ID_INVALID",
          400
        ),
        {
          errorCode: "THREAD_ID_INVALID",
          outcome: "invalid_request",
        }
      )
    }

    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          error.message,
          "THREAD_STORE_NOT_INITIALIZED",
          500
        ),
        {
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          outcome: "error",
        }
      )
    }

    logger.error("Failed to fetch threads.", {
      error,
      errorCode: "THREADS_FETCH_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Failed to fetch threads.",
        "THREADS_FETCH_FAILED",
        500
      ),
      {
        errorCode: "THREADS_FETCH_FAILED",
        outcome: "error",
      }
    )
  }
}

export async function PUT(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "PUT",
    requestId,
    route: "/api/threads",
  })

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return observeRouteResponse(observation, session, {
        errorCode: session.headers.get("X-Error-Code") ?? undefined,
        outcome: "request_rejected",
      })
    }

    const payload: unknown = await request.json()
    const thread = parseThreadPayload(payload)
    const savedThread = await upsertThreadForUser(session.user.id, thread)

    return observeRouteResponse(
      observation,
      NextResponse.json(savedThread, {
        headers: createHeaders(requestId),
      }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    if (error instanceof ZodError) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid thread payload.",
          "THREADS_INVALID_PAYLOAD",
          400
        ),
        {
          errorCode: "THREADS_INVALID_PAYLOAD",
          outcome: "invalid_request",
        }
      )
    }

    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          error.message,
          "THREAD_STORE_NOT_INITIALIZED",
          500
        ),
        {
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          outcome: "error",
        }
      )
    }

    logger.error("Failed to save thread.", {
      error,
      errorCode: "THREAD_SAVE_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Failed to save thread.",
        "THREAD_SAVE_FAILED",
        500
      ),
      {
        errorCode: "THREAD_SAVE_FAILED",
        outcome: "error",
      }
    )
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "DELETE",
    requestId,
    route: "/api/threads",
  })

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return observeRouteResponse(observation, session, {
        errorCode: session.headers.get("X-Error-Code") ?? undefined,
        outcome: "request_rejected",
      })
    }

    const payload: unknown = await request.json()
    const { id } = deleteThreadSchema.parse(payload)

    await deleteThreadForUser(session.user.id, id)
    try {
      await deleteLongTermMemoriesForThread({
        requestId,
        signal: request.signal,
        threadId: id,
        userId: session.user.id,
      })
    } catch (error) {
      logger.warn("Failed to clean up long-term memories for deleted thread.", {
        error,
        errorCode: "THREAD_MEMORY_DELETE_FAILED",
        requestId,
      })
    }

    return observeRouteResponse(
      observation,
      new NextResponse(null, {
        status: 204,
        headers: createHeaders(requestId),
      }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    if (error instanceof ZodError) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid thread id.",
          "THREAD_ID_INVALID",
          400
        ),
        {
          errorCode: "THREAD_ID_INVALID",
          outcome: "invalid_request",
        }
      )
    }

    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          error.message,
          "THREAD_STORE_NOT_INITIALIZED",
          500
        ),
        {
          errorCode: "THREAD_STORE_NOT_INITIALIZED",
          outcome: "error",
        }
      )
    }

    logger.error("Failed to delete thread.", {
      error,
      errorCode: "THREAD_DELETE_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Failed to delete thread.",
        "THREAD_DELETE_FAILED",
        500
      ),
      {
        errorCode: "THREAD_DELETE_FAILED",
        outcome: "error",
      }
    )
  }
}
