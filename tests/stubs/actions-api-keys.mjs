import { getTestMocks } from "./mock-state.mjs"

export function getModels() {
  return (
    getTestMocks().apiKeys?.getModels?.() ?? [
      { id: "alibaba/qwen3.7-max" },
      { id: "moonshotai/kimi-k2.6" },
      { id: "xiaomi/mimo-v2.5-pro" },
    ]
  )
}
