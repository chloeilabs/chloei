import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return (
    getTestMocks().apiKeys?.getModels?.() ?? [
      { id: "anthropic/claude-sonnet-4.6" },
    ]
  )
}
