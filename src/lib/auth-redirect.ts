export const AUTH_REDIRECT_QUERY_PARAM = "redirectTo"
export const DEFAULT_AUTH_REDIRECT_PATH = "/"

export function readSearchParam(
  value: string | string[] | undefined
): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }

  return typeof value === "string" ? value : null
}

export function sanitizeAuthRedirectPath(
  value: string | null | undefined
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_AUTH_REDIRECT_PATH
  }

  return value
}
