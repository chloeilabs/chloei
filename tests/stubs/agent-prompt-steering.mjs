import { getTestMocks } from "./mock-state.mjs"

export function resolvePromptProvider() {
  return getTestMocks().agentPromptSteering?.resolvePromptProvider?.() ?? "zai"
}
