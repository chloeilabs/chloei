// Pure predicates that decide when to inject synthesis nudges into the agent
// runtime's prepareStep. Kept dependency-free so they're trivial to unit-test
// without dragging in the AI SDK.

export function shouldForceFinalSynthesisStep(
  stepNumber: number,
  toolMaxSteps: number
): boolean {
  return stepNumber >= Math.max(0, toolMaxSteps - 1)
}

export function shouldNudgeMidBudgetSynthesis(
  stepNumber: number,
  toolMaxSteps: number
): boolean {
  if (toolMaxSteps <= 3) {
    return false
  }
  // Kick in at one-third of budget. The failing 10-K tasks (Kimi K2.6 and
  // Gemini 3.1 Pro) tend to stop naturally with empty text after only 5-8
  // tool calls (~steps 4-7 of 20); half-budget fires too late to reach them.
  const threshold = Math.max(2, Math.floor(toolMaxSteps / 3))
  return stepNumber >= threshold && stepNumber < toolMaxSteps - 1
}
