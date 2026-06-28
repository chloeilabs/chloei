import { getTestMocks } from "./mock-state.mjs"

export class MaxTurnsExceededError extends Error {
  constructor(message) {
    super(message ?? "max turns exceeded")
    this.name = "MaxTurnsExceededError"
  }
}

export class Agent {
  constructor(options) {
    this.options = options ?? {}
  }

  asTool(options) {
    return {
      type: "function",
      name: options?.toolName ?? this.options.name,
      options,
    }
  }
}

export function tool(definition) {
  return { type: "function", ...definition }
}

export function setDefaultOpenAIKey() {}

export function setOpenAIResponsesTransport() {}

export function getGlobalTraceProvider() {
  return { setDisabled() {} }
}

/**
 * Builds a streamed-run result: async-iterable of events + completed + history
 * + state.usage (mirrors the real SDK so usage logging can read it).
 */
export function makeStreamResult(events, history, usage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
    completed: Promise.resolve(),
    history: history ?? [],
    state: {
      usage: usage ?? {
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokensDetails: [],
        outputTokensDetails: [],
        requestUsageEntries: undefined,
      },
    },
  }
}

export function run(agent, input, options) {
  const impl = getTestMocks().agents?.run
  if (typeof impl === "function") {
    return impl(agent, input, options)
  }
  return makeStreamResult([], [])
}
