import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return getTestMocks().apiKeys?.getModels?.() ?? [{ id: "qwen/qwen3.6-plus" }]
}
