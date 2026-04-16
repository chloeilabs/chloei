import { getTestMocks } from "./mock-state.mjs"

export function evaluateAndConsumeSlidingWindowRateLimit(params) {
  return (
    getTestMocks().rateLimit?.evaluateAndConsumeSlidingWindowRateLimit?.(
      params
    ) ?? null
  )
}

export function tryAcquireConcurrencySlot(params) {
  return getTestMocks().rateLimit?.tryAcquireConcurrencySlot?.(params) ?? null
}
