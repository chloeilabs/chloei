"use client"

import { createAuthClient } from "better-auth/react"

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

export const authClient = createAuthClient({
  baseURL: getAuthClientBaseUrl(),
})

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
