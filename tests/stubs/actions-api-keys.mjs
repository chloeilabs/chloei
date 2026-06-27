import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return getTestMocks().apiKeys?.getModels?.() ?? [{ id: "gpt-5.4-mini" }]
}
