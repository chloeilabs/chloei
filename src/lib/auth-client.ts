"use client"

import type { createAuthClient } from "better-auth/react"

import {
  AUTH_REDIRECT_QUERY_PARAM,
  DEFAULT_AUTH_REDIRECT_PATH,
  sanitizeAuthRedirectPath,
} from "./auth-redirect"

function getAuthClientBaseUrl(): string {
  if (typeof window === "undefined") {
    return "http://localhost:3000"
  }

  return window.location.origin
}

function getCurrentPathnameWithSearch(): string {
  if (typeof window === "undefined") {
    return DEFAULT_AUTH_REDIRECT_PATH
  }

  const { pathname, search } = window.location
  return `${pathname}${search}`
}

type AuthClient = ReturnType<typeof createAuthClient>

let authClient: AuthClient | null = null
let authClientPromise: Promise<AuthClient> | null = null

export async function getAuthClient(): Promise<AuthClient> {
  if (authClient) {
    return authClient
  }

  if (authClientPromise) {
    return authClientPromise
  }

  authClientPromise = (async () => {
    try {
      const { createAuthClient } = await import("better-auth/react")
      authClient = createAuthClient({
        baseURL: getAuthClientBaseUrl(),
      })
      return authClient
    } catch (error) {
      authClientPromise = null
      throw error
    }
  })()

  return authClientPromise
}

export function redirectToSignIn(
  redirectTo: string = getCurrentPathnameWithSearch()
) {
  if (typeof window === "undefined") {
    return
  }

  const safeRedirectTo = sanitizeAuthRedirectPath(redirectTo)
  const signInUrl = new URL("/sign-in", window.location.origin)

  if (safeRedirectTo !== DEFAULT_AUTH_REDIRECT_PATH) {
    signInUrl.searchParams.set(AUTH_REDIRECT_QUERY_PARAM, safeRedirectTo)
  }

  window.location.assign(signInUrl.toString())
}
