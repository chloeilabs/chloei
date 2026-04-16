import { getTestMocks } from "./mock-state.mjs"

export function withAiSdkInlineCitationInstruction(instruction, options) {
  return (
    getTestMocks().systemInstructionAugmentations?.withAiSdkInlineCitationInstruction?.(
      instruction,
      options
    ) ?? instruction
  )
}
