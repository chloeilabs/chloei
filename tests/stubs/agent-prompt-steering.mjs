import { getTestMocks } from "./mock-state.mjs"

export function resolvePromptProvider(model) {
  return (
    getTestMocks().agentPromptSteering?.resolvePromptProvider?.(model) ??
    "moonshotai"
  )
}
