import { getTestMocks } from "./mock-state.mjs"

export function inferPromptTaskMode(messages, options) {
  return (
    getTestMocks().agentPromptSteering?.inferPromptTaskMode?.(
      messages,
      options
    ) ?? "general"
  )
}

export function resolvePromptProvider(model) {
  return (
    getTestMocks().agentPromptSteering?.resolvePromptProvider?.(model) ??
    "moonshotai"
  )
}

export function inferUserExpertiseFromMemory(memoryContext) {
  return (
    getTestMocks().agentPromptSteering?.inferUserExpertiseFromMemory?.(
      memoryContext
    ) ?? undefined
  )
}
