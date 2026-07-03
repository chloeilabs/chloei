// Stub for @/lib/server/llm/goblins-background-run: the real module pulls the
// run store (pg) and raw OpenAI client. Tests script it via mock-state.
import { getTestMocks } from "./mock-state.mjs"

export async function createGoblinsBackgroundRun(params) {
  const impl = getTestMocks().goblinsBackgroundRun?.create
  if (typeof impl === "function") {
    return impl(params)
  }
  return {
    runId: "run-stub",
    threadId: params.threadId,
    assistantMessageId: "assistant-stub",
    status: "awaiting_manager",
  }
}

export async function continueGoblinsRun(runId, responseId) {
  const impl = getTestMocks().goblinsBackgroundRun?.continue
  if (typeof impl === "function") {
    return impl(runId, responseId)
  }
}

export async function failGoblinsRun(runId, status, error) {
  const impl = getTestMocks().goblinsBackgroundRun?.fail
  if (typeof impl === "function") {
    return impl(runId, status, error)
  }
}
