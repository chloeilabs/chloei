import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return getTestMocks().apiKeys?.getModels?.() ?? [{ id: "zai/glm-5.2" }]
}
