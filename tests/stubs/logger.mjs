import { getTestMocks } from "./mock-state.mjs"

export function createLogger(scope) {
  return {
    info(message, details) {
      getTestMocks().logger?.createLogger?.(scope)?.info?.(message, details)
    },
    warn(message, error) {
      getTestMocks().logger?.createLogger?.(scope)?.warn?.(message, error)
    },
    error(message, error) {
      getTestMocks().logger?.createLogger?.(scope)?.error?.(message, error)
    },
  }
}
