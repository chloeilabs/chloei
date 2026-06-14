import { getTestMocks } from "./mock-state.mjs"

export function withAiSdkInlineCitationInstruction(instruction) {
  return (
    getTestMocks().systemInstructionAugmentations?.withAiSdkInlineCitationInstruction?.(
      instruction
    ) ?? instruction
  )
}
