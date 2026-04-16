import { type NextRequest, NextResponse } from "next/server"
import { z, ZodError } from "zod"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import { createApiErrorResponse, createApiHeaders } from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  deleteThreadForUser,
  isThreadStoreNotInitializedError,
  listThreadsForUser,
  parseThreadPayload,
  upsertThreadForUser,
} from "@/lib/server/threads"

export const runtime = "nodejs"

const deleteThreadSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
  })
  .strict()

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

export async function GET(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return session
    }

    const threads = await listThreadsForUser(session.user.id)

    return NextResponse.json(threads, {
      headers: createHeaders(requestId),
    })
  } catch (error) {
    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return createErrorResponse(
        requestId,
        error.message,
        "THREAD_STORE_NOT_INITIALIZED",
        500
      )
    }

    logger.error("Failed to fetch threads.", {
      error,
      errorCode: "THREADS_FETCH_FAILED",
      requestId,
    })
    return createErrorResponse(
      requestId,
      "Failed to fetch threads.",
      "THREADS_FETCH_FAILED",
      500
    )
  }
}

export async function PUT(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return session
    }

    const payload: unknown = await request.json()
    const thread = parseThreadPayload(payload)
    const savedThread = await upsertThreadForUser(session.user.id, thread)

    return NextResponse.json(savedThread, {
      headers: createHeaders(requestId),
    })
  } catch (error) {
    if (error instanceof ZodError) {
      return createErrorResponse(
        requestId,
        "Invalid thread payload.",
        "THREADS_INVALID_PAYLOAD",
        400
      )
    }

    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return createErrorResponse(
        requestId,
        error.message,
        "THREAD_STORE_NOT_INITIALIZED",
        500
      )
    }

    logger.error("Failed to save thread.", {
      error,
      errorCode: "THREAD_SAVE_FAILED",
      requestId,
    })
    return createErrorResponse(
      requestId,
      "Failed to save thread.",
      "THREAD_SAVE_FAILED",
      500
    )
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`threads:${requestId}`)

  try {
    const session = await requireSession(request, requestId)

    if (session instanceof Response) {
      return session
    }

    const payload: unknown = await request.json()
    const { id } = deleteThreadSchema.parse(payload)

    await deleteThreadForUser(session.user.id, id)

    return new NextResponse(null, {
      status: 204,
      headers: createHeaders(requestId),
    })
  } catch (error) {
    if (error instanceof ZodError) {
      return createErrorResponse(
        requestId,
        "Invalid thread id.",
        "THREAD_ID_INVALID",
        400
      )
    }

    if (isThreadStoreNotInitializedError(error)) {
      logger.error("Thread store is not initialized.", {
        error,
        errorCode: "THREAD_STORE_NOT_INITIALIZED",
        requestId,
      })
      return createErrorResponse(
        requestId,
        error.message,
        "THREAD_STORE_NOT_INITIALIZED",
        500
      )
    }

    logger.error("Failed to delete thread.", {
      error,
      errorCode: "THREAD_DELETE_FAILED",
      requestId,
    })
    return createErrorResponse(
      requestId,
      "Failed to delete thread.",
      "THREAD_DELETE_FAILED",
      500
    )
  }
}
