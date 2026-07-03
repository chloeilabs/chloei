import { getTestMocks } from "./mock-state.mjs"

// Stub raw OpenAI client. Tests drive webhook verification via the
// `webhookUnwrap` mock: return an event to simulate a valid signature, or throw
// to simulate an invalid one.
export function getOpenAiClient() {
  return {
    webhooks: {
      unwrap: async (payload, headers, secret) => {
        const impl = getTestMocks().webhookUnwrap
        if (typeof impl === "function") {
          return impl(payload, headers, secret)
        }
        throw new Error("invalid signature")
      },
    },
    // Raw Responses API surface for the goblins background engine tests,
    // scripted via mock-state (rawResponses.{retrieve,create,cancel}).
    responses: {
      retrieve: async (responseId, options) => {
        const impl = getTestMocks().rawResponses?.retrieve
        if (typeof impl === "function") {
          return impl(responseId, options)
        }
        throw new Error("rawResponses.retrieve not scripted")
      },
      create: async (params) => {
        const impl = getTestMocks().rawResponses?.create
        if (typeof impl === "function") {
          return impl(params)
        }
        throw new Error("rawResponses.create not scripted")
      },
      cancel: async (responseId) => {
        const impl = getTestMocks().rawResponses?.cancel
        if (typeof impl === "function") {
          return impl(responseId)
        }
        return { id: responseId, status: "cancelled" }
      },
    },
  }
}
