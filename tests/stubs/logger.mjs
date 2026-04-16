import { getTestMocks } from "./mock-state.mjs"

export function createLogger(scope) {
  return (
    getTestMocks().logger?.createLogger?.(scope) ?? {
      warn() {},
      error() {},
    }
  )
}
