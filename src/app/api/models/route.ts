import { type NextRequest, NextResponse } from "next/server"

import { getModels } from "@/lib/actions/api-keys"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  }

  try {
    if (!isAuthConfigured()) {
      return createAuthUnavailableResponse(headers)
    }

    const session = await getRequestSession(request.headers)

    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized." },
        {
          status: 401,
          headers,
        }
      )
    }

    const models = getModels()
    return NextResponse.json(models, {
      headers,
    })
  } catch (error) {
    console.error(`[models:${requestId}] Failed to fetch model list:`, error)
    return NextResponse.json(
      { error: "Failed to fetch models." },
      {
        status: 500,
        headers,
      }
    )
  }
}
