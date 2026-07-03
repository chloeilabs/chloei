// Stub for @/lib/server/llm/vector-stores (real module uses the raw OpenAI
// client). Tests script it via mock-state; default is "no vector store".
import { getTestMocks } from "./mock-state.mjs"

export async function ensureGoblinsVectorStore(params) {
  const impl = getTestMocks().vectorStores?.ensure
  if (typeof impl === "function") {
    return impl(params)
  }
  return null
}
