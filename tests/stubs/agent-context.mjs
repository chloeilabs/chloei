import { getTestMocks } from "./mock-state.mjs"

export function buildAgentSystemInstruction(user, context) {
  return (
    getTestMocks().agentContext?.buildAgentSystemInstruction?.(user, context) ??
    "system-instruction"
  )
}
