export interface DcfScenarioInput {
  startingFcf: number
  fcfCagr: number
  years: number
  wacc: number
  terminalGrowth: number
  netCash?: number
  dilutedShares?: number
}

export interface DcfScenarioOutput {
  enterpriseValue: number
  equityValue: number
  impliedPrice?: number
}

export interface ProbabilityWeightedScenario {
  probability: number
  price: number
}

export function calculateDcfScenario(
  input: DcfScenarioInput
): DcfScenarioOutput {
  if (input.wacc <= input.terminalGrowth) {
    throw new Error("WACC must be greater than terminal growth.")
  }

  let presentValue = 0
  let fcf = input.startingFcf
  for (let year = 1; year <= input.years; year += 1) {
    fcf *= 1 + input.fcfCagr
    presentValue += fcf / (1 + input.wacc) ** year
  }

  const terminalValue =
    (fcf * (1 + input.terminalGrowth)) / (input.wacc - input.terminalGrowth)
  const terminalPresentValue = terminalValue / (1 + input.wacc) ** input.years
  const enterpriseValue = presentValue + terminalPresentValue
  const equityValue = enterpriseValue + (input.netCash ?? 0)

  return {
    enterpriseValue,
    equityValue,
    ...(input.dilutedShares && input.dilutedShares > 0
      ? { impliedPrice: equityValue / input.dilutedShares }
      : {}),
  }
}

export function calculateProbabilityWeightedExpectedValue(
  scenarios: readonly ProbabilityWeightedScenario[]
): number {
  const probabilitySum = scenarios.reduce(
    (sum, scenario) => sum + scenario.probability,
    0
  )
  if (Math.abs(probabilitySum - 1) > 0.0001) {
    throw new Error("Scenario probabilities must sum to 1.")
  }

  return scenarios.reduce(
    (sum, scenario) => sum + scenario.probability * scenario.price,
    0
  )
}
