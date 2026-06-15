import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/agent-session-state.ts")
).href

const {
  attachFollowUpQuestionsToMessage,
  createAssistantMessageFromAccumulator,
  hasVisibleStructuredOutput,
  setFollowUpQuestionsPendingForMessage,
  upsertAgentMessage,
} = await import(moduleUrl)

function createAccumulator(overrides = {}) {
  return {
    content: "",
    reasoning: "",
    agentStatus: undefined,
    interactionId: undefined,
    lastEventId: undefined,
    toolInvocations: [],
    activityTimeline: [],
    sources: [],
    nextActivityOrder: 0,
    ...overrides,
  }
}

test("assistant session state builds assistant messages from stream accumulators", () => {
  const accumulator = createAccumulator({
    content: "Done.",
    reasoning: "Checked the source.",
    agentStatus: "completed",
    toolInvocations: [
      {
        id: "tool-1",
        callId: "call-1",
        toolName: "tavily_search",
        label: "Search",
        query: "query",
        status: "success",
      },
    ],
    activityTimeline: [
      {
        id: "activity-1",
        kind: "reasoning",
        order: 0,
        createdAt: "2026-04-30T12:00:00.000Z",
        text: "Checked the source.",
      },
    ],
    sources: [
      {
        id: "source-1",
        title: "Source",
        url: "https://example.com",
      },
    ],
  })

  const message = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator,
    model: "moonshotai/kimi-k2.6",
    isStreaming: true,
  })

  assert.equal(message.id, "assistant-1")
  assert.equal(message.role, "assistant")
  assert.equal(message.content, "Done.")
  assert.equal(message.metadata?.isStreaming, true)
  assert.deepEqual(message.metadata?.parts, [{ type: "text", text: "Done." }])
  assert.equal(message.metadata?.reasoning, "Checked the source.")
  assert.equal(message.metadata?.agentStatus, "completed")
  assert.equal(message.metadata?.toolInvocations?.length, 1)
  assert.equal(message.metadata?.activityTimeline?.length, 1)
  assert.equal(message.metadata?.activityTimeline?.[0]?.kind, "reasoning")
  assert.equal(message.metadata?.sources?.length, 1)
  assert.equal(hasVisibleStructuredOutput(accumulator), true)
})

test("assistant session state omits empty structured fields and upserts by id", () => {
  const firstMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Partial" }),
    model: "moonshotai/kimi-k2.6",
    isStreaming: true,
  })
  const finalMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Final" }),
    model: "moonshotai/kimi-k2.6",
    isStreaming: false,
  })

  assert.equal("reasoning" in firstMessage.metadata, false)
  assert.equal(hasVisibleStructuredOutput(createAccumulator()), false)
  assert.deepEqual(upsertAgentMessage([], firstMessage), [firstMessage])
  assert.deepEqual(upsertAgentMessage([firstMessage], finalMessage), [
    finalMessage,
  ])
})

test("assistant session state attaches follow-up questions without changing content", () => {
  const assistantMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Final answer." }),
    model: "moonshotai/kimi-k2.6",
    isStreaming: false,
  })
  const updatedMessages = attachFollowUpQuestionsToMessage(
    [assistantMessage],
    "assistant-1",
    [
      { id: "follow-up-1", text: "Can you give an example?" },
      { id: "follow-up-2", text: "What should I do next?" },
    ]
  )

  assert.equal(updatedMessages[0]?.content, "Final answer.")
  assert.deepEqual(updatedMessages[0]?.metadata?.parts, [
    { type: "text", text: "Final answer." },
  ])
  assert.deepEqual(updatedMessages[0]?.metadata?.followUpQuestions, [
    { id: "follow-up-1", text: "Can you give an example?" },
    { id: "follow-up-2", text: "What should I do next?" },
  ])
  assert.equal(
    updatedMessages[0]?.metadata?.followUpQuestionsPending,
    undefined
  )
})

test("assistant session state tracks pending follow-up questions", () => {
  const assistantMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Final answer." }),
    model: "moonshotai/kimi-k2.6",
    isStreaming: false,
  })

  const pendingMessages = setFollowUpQuestionsPendingForMessage(
    [assistantMessage],
    "assistant-1",
    true
  )
  assert.equal(pendingMessages[0]?.metadata?.followUpQuestionsPending, true)

  const clearedMessages = setFollowUpQuestionsPendingForMessage(
    pendingMessages,
    "assistant-1",
    false
  )
  assert.equal(
    clearedMessages[0]?.metadata?.followUpQuestionsPending,
    undefined
  )
})
