import { type NextRequest, NextResponse } from "next/server"

import {
  AUTH_REDIRECT_QUERY_PARAM,
  DEFAULT_AUTH_REDIRECT_PATH,
  sanitizeAuthRedirectPath,
} from "@/lib/auth-redirect"
import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import { createApiErrorResponse } from "@/lib/server/api-response"
import {
  AUTH_UNAVAILABLE_ERROR_CODE,
  AUTH_UNAVAILABLE_MESSAGE,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"

function isAuthPage(pathname: string): boolean {
  return pathname === "/sign-in" || pathname === "/sign-up"
}

function createSignInRedirectUrl(request: NextRequest): URL {
  const redirectUrl = new URL("/sign-in", request.url)
  const redirectPath = `${request.nextUrl.pathname}${request.nextUrl.search}`

  if (redirectPath !== DEFAULT_AUTH_REDIRECT_PATH) {
    redirectUrl.searchParams.set(AUTH_REDIRECT_QUERY_PARAM, redirectPath)
  }

  return redirectUrl
}

function createAuthUnavailableApiResponse(requestId: string) {
  return createApiErrorResponse({
    requestId,
    error: AUTH_UNAVAILABLE_MESSAGE,
    errorCode: AUTH_UNAVAILABLE_ERROR_CODE,
    status: 503,
  })
}

export async function proxy(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`proxy:${requestId}`)
  const { pathname } = request.nextUrl

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next()
  }

  if (!isAuthConfigured()) {
    if (isAuthPage(pathname)) {
      return NextResponse.next()
    }

    if (pathname.startsWith("/api/")) {
      return createAuthUnavailableApiResponse(requestId)
    }

    return NextResponse.redirect(createSignInRedirectUrl(request))
  }

  let session = null

  try {
    session = await getRequestSession(request.headers)
  } catch (error) {
    logger.error("Failed to resolve auth session.", {
      error,
      errorCode: "PROXY_AUTH_SESSION_FAILED",
      requestId,
    })
    return NextResponse.next()
  }

  if (isAuthPage(pathname)) {
    if (!session) {
      return NextResponse.next()
    }

    const requestedRedirect = sanitizeAuthRedirectPath(
      request.nextUrl.searchParams.get(AUTH_REDIRECT_QUERY_PARAM)
    )

    return NextResponse.redirect(new URL(requestedRedirect, request.url))
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return createApiErrorResponse({
        requestId,
        error: "Unauthorized.",
        errorCode: "PROXY_UNAUTHORIZED",
        status: 401,
      })
    }

    return NextResponse.redirect(createSignInRedirectUrl(request))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/", "/sign-in", "/sign-up", "/api/:path*"],
}
