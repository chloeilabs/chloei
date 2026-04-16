const mockStateKey = Symbol.for("chloei.tests.mock-state")

export function getTestMocks() {
  if (!globalThis[mockStateKey]) {
    globalThis[mockStateKey] = {}
  }

  return globalThis[mockStateKey]
}

export function resetTestMocks() {
  globalThis[mockStateKey] = {}
  return globalThis[mockStateKey]
}

export function setTestMocks(partialState) {
  Object.assign(getTestMocks(), partialState)
  return getTestMocks()
}
