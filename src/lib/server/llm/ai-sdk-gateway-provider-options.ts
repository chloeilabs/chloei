export function getAiSdkGatewayProviderOptions() {
  return getAiSdkGatewayProviderOptionsForMode()
}

export function getAiSdkGatewayProviderOptionsForMode({
  deepResearch = false,
}: {
  deepResearch?: boolean
} = {}) {
  return {
    ...(deepResearch
      ? {
          openai: {
            reasoningEffort: "xhigh",
            reasoningSummary: "detailed",
            textVerbosity: "high",
          },
        }
      : {}),
  }
}
