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
  // Kick in at half-budget so the model sees the nudge before it stops
  // naturally with empty text around the 40-60% mark. Empirically the most
  // common failure point on hard 10-K tasks (Kimi K2.6) is steps 8-12 of 20.
  const threshold = Math.max(2, Math.floor(toolMaxSteps / 2))
  return stepNumber >= threshold && stepNumber < toolMaxSteps - 1
}
