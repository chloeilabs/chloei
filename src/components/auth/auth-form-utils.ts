import { AUTH_REDIRECT_QUERY_PARAM } from "@/lib/auth-redirect"

export function getAuthErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message
  }

  return fallback
}

export function buildAuthHref(pathname: string, redirectTo: string): string {
  if (redirectTo === "/") {
    return pathname
  }

  return `${pathname}?${AUTH_REDIRECT_QUERY_PARAM}=${encodeURIComponent(redirectTo)}`
}
