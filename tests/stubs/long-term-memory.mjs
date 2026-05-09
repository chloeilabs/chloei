import { getTestMocks } from "./mock-state.mjs"

export async function getLongTermMemoryContext(params) {
  return getTestMocks().longTermMemory?.getLongTermMemoryContext?.(params)
}

export function isLongTermMemoryEnabled(config) {
  return (
    getTestMocks().longTermMemory?.isLongTermMemoryEnabled?.(config) ?? false
  )
}

export async function commitLongTermMemory(params) {
  return getTestMocks().longTermMemory?.commitLongTermMemory?.(params) ?? false
}

export async function deleteLongTermMemoriesForThread(params) {
  return (
    getTestMocks().longTermMemory?.deleteLongTermMemoriesForThread?.(params) ??
    false
  )
}
