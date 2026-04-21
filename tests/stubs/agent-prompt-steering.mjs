import { getTestMocks } from "./mock-state.mjs"

export function inferPromptTaskMode(messages) {
  return (
    getTestMocks().agentPromptSteering?.inferPromptTaskMode?.(messages) ??
    "analysis"
  )
}

export function resolvePromptProvider(model) {
  return (
    getTestMocks().agentPromptSteering?.resolvePromptProvider?.(model) ??
    "anthropic"
  )
}
