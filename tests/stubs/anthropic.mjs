const anthropicCalls = []

export const anthropic = {
  tools: {
    webSearch_20250305(options) {
      anthropicCalls.push({
        tool: "webSearch_20250305",
        options,
      })

      return {
        type: "webSearch_20250305",
        options,
      }
    },
    webSearch_20260209(options) {
      anthropicCalls.push({
        tool: "webSearch_20260209",
        options,
      })

      return {
        type: "webSearch_20260209",
        options,
      }
    },
  },
}

export function getAnthropicCalls() {
  return [...anthropicCalls]
}

export function resetAnthropicCalls() {
  anthropicCalls.length = 0
}
