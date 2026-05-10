import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return (
    getTestMocks().apiKeys?.getModels?.() ?? [{ id: "moonshotai/kimi-k2.6" }]
  )
}
