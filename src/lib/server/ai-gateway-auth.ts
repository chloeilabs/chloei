import { isE2eMockModeEnabled } from "./e2e-test-mode"

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed
}

/** True when the app can authenticate to Vercel AI Gateway (API key, OIDC, or E2E mock). */
export function isAiGatewayAuthConfigured(): boolean {
  if (isE2eMockModeEnabled()) {
    return true
  }

  return Boolean(
    trimEnv(process.env.AI_GATEWAY_API_KEY) ??
      trimEnv(process.env.VERCEL_OIDC_TOKEN)
  )
}

/** Explicit API key for createGateway; omit when using OIDC-only auth. */
export function resolveAiGatewayApiKeySetting(): string | undefined {
  return trimEnv(process.env.AI_GATEWAY_API_KEY)
}
