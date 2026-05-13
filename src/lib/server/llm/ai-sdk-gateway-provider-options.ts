const GEMINI_HIGH_THINKING_PROVIDER_OPTIONS = {
  google: {
    thinkingConfig: {
      thinkingLevel: "high",
      includeThoughts: true,
    },
  },
} as const

export function getAiSdkGatewayProviderOptions() {
  return getAiSdkGatewayProviderOptionsForMode()
}

export function getAiSdkGatewayProviderOptionsForMode({
  deepResearch = false,
}: {
  deepResearch?: boolean
} = {}) {
  return deepResearch ? GEMINI_HIGH_THINKING_PROVIDER_OPTIONS : {}
}
