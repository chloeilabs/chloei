import type {
  PromptProvider,
  PromptTaskMode,
} from "@/lib/server/agent-prompt-steering"

type GeminiThinkingLevel = "low" | "medium" | "high"

function buildGeminiThinkingOptions(level: GeminiThinkingLevel) {
  return {
    google: {
      thinkingConfig: {
        thinkingLevel: level,
        includeThoughts: true,
      },
    },
  } as const
}

const GEMINI_HIGH_THINKING_PROVIDER_OPTIONS = buildGeminiThinkingOptions("high")

/**
 * Map a (provider, taskMode) pair to AI SDK provider options.
 *
 * Today only Gemini exposes an explicit reasoning knob through AI Gateway
 * (`thinkingConfig.thinkingLevel`); Kimi K2.6 and MiMo V2.5 Pro reason
 * natively without a per-call provider option. Returning `{}` for those
 * providers is the correct no-op — once AI Gateway surfaces reasoning options
 * for them, just extend this map.
 */
export function getAiSdkGatewayProviderOptionsForTaskMode(params: {
  provider: PromptProvider
  taskMode: PromptTaskMode
}) {
  if (params.provider !== "google") {
    return {}
  }

  switch (params.taskMode) {
    case "finance_analysis":
    case "research":
    case "high_stakes":
    case "debugging":
      return buildGeminiThinkingOptions("high")
    case "coding":
      return buildGeminiThinkingOptions("medium")
    case "instruction_following":
    case "closed_answer":
      // Format-sensitive / one-answer tasks: minimal thinking, keep includeThoughts
      // on so the trace stays observable for telemetry.
      return buildGeminiThinkingOptions("low")
    case "writing":
    case "general":
      return {}
  }

  // Exhaustiveness guard: if a new PromptTaskMode is added, this assignment
  // becomes a type error so we don't silently fall through. At runtime, return
  // the safe no-op so an unknown mode never blocks the request.
  const _unhandledTaskMode: never = params.taskMode
  void _unhandledTaskMode
  return {}
}

export function getAiSdkGatewayProviderOptions() {
  return getAiSdkGatewayProviderOptionsForMode()
}

// Legacy shim for callers that only know about the deep-research flag (eval
// harness, etc.). Prefer getAiSdkGatewayProviderOptionsForTaskMode for new code.
export function getAiSdkGatewayProviderOptionsForMode({
  deepResearch = false,
}: {
  deepResearch?: boolean
} = {}) {
  return deepResearch ? GEMINI_HIGH_THINKING_PROVIDER_OPTIONS : {}
}
