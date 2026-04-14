import { type NextRequest, NextResponse } from "next/server"
import { z, ZodError } from "zod"

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
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  }
}

function createErrorResponse(requestId: string, error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: createHeaders(requestId),
    }
  )
}

async function requireSession(request: NextRequest, requestId: string) {
  if (!isAuthConfigured()) {
    return createAuthUnavailableResponse(createHeaders(requestId))
  }

  const session = await getRequestSession(request.headers)

  if (!session) {
    return createErrorResponse(requestId, "Unauthorized.", 401)
  }

  return session
}

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()

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
      return createErrorResponse(requestId, error.message, 500)
    }

    console.error(`[threads:${requestId}] Failed to fetch threads:`, error)
    return createErrorResponse(requestId, "Failed to fetch threads.", 500)
  }
}

export async function PUT(request: NextRequest) {
  const requestId = crypto.randomUUID()

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
      return createErrorResponse(requestId, "Invalid thread payload.", 400)
    }

    if (isThreadStoreNotInitializedError(error)) {
      return createErrorResponse(requestId, error.message, 500)
    }

    console.error(`[threads:${requestId}] Failed to save thread:`, error)
    return createErrorResponse(requestId, "Failed to save thread.", 500)
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = crypto.randomUUID()

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
      return createErrorResponse(requestId, "Invalid thread id.", 400)
    }

    if (isThreadStoreNotInitializedError(error)) {
      return createErrorResponse(requestId, error.message, 500)
    }

    console.error(`[threads:${requestId}] Failed to delete thread:`, error)
    return createErrorResponse(requestId, "Failed to delete thread.", 500)
  }
}
