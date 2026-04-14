import { type NextRequest, NextResponse } from "next/server"

import {
  AUTH_REDIRECT_QUERY_PARAM,
  DEFAULT_AUTH_REDIRECT_PATH,
  sanitizeAuthRedirectPath,
} from "@/lib/auth-redirect"
import { AUTH_UNAVAILABLE_MESSAGE, isAuthConfigured } from "@/lib/server/auth"
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

function createAuthUnavailableApiResponse() {
  return NextResponse.json(
    { error: AUTH_UNAVAILABLE_MESSAGE },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  )
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next()
  }

  if (!isAuthConfigured()) {
    if (isAuthPage(pathname)) {
      return NextResponse.next()
    }

    if (pathname.startsWith("/api/")) {
      return createAuthUnavailableApiResponse()
    }

    return NextResponse.redirect(createSignInRedirectUrl(request))
  }

  let session = null

  try {
    session = await getRequestSession(request.headers)
  } catch (error) {
    console.error("[proxy] Failed to resolve auth session:", error)
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
      return NextResponse.json(
        { error: "Unauthorized." },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        }
      )
    }

    return NextResponse.redirect(createSignInRedirectUrl(request))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/", "/sign-in", "/sign-up", "/api/:path*"],
}
