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
  }
}
