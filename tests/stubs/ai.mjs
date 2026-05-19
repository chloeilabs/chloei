import { getTestMocks } from "./mock-state.mjs"

export function tool(definition) {
  return definition
}

export function jsonSchema(schema) {
  return { jsonSchema: schema }
}

export function stepCountIs(count) {
  return { type: "step-count", count }
}

export const Output = {
  object(config) {
    return {
      type: "object",
      ...config,
    }
  },
}

export const gateway = {
  tools: {
    parallelSearch(config) {
      return {
        type: "provider-defined",
        id: "gateway.parallel_search",
        args: config,
      }
    },
  },
}

export async function generateText(params) {
  return getTestMocks().ai?.generateText?.(params) ?? { text: "" }
}

export function streamText() {
  throw new Error("streamText is not available in the test stub.")
}
