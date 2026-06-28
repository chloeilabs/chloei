import OpenAI from "openai"

// Memoized raw OpenAI client, keyed by API key. The Agents SDK doesn't expose
// platform endpoints (webhook signature verification, background responses,
// resumable streaming), so those features use a direct client. Kept in its own
// module so the raw `openai` import stays out of the shared agent runtime.
let client: OpenAI | undefined
let clientKey: string | undefined

export function getOpenAiClient(apiKey: string): OpenAI {
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ apiKey })
    clientKey = apiKey
  }
  return client
}
