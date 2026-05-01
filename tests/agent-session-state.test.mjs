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
  createAssistantMessageFromAccumulator,
  getThreadAttachmentPayloads,
  hasVisibleStructuredOutput,
  pruneThreadAttachmentPayloads,
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
        toolName: "web_search",
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
    model: "anthropic/claude-sonnet-4.6",
    runMode: "research",
    isStreaming: true,
  })

  assert.equal(message.id, "assistant-1")
  assert.equal(message.role, "assistant")
  assert.equal(message.content, "Done.")
  assert.equal(message.metadata?.isStreaming, true)
  assert.equal(message.metadata?.runMode, "research")
  assert.deepEqual(message.metadata?.parts, [{ type: "text", text: "Done." }])
  assert.equal(message.metadata?.reasoning, "Checked the source.")
  assert.equal(message.metadata?.agentStatus, "completed")
  assert.equal(message.metadata?.toolInvocations?.length, 1)
  assert.equal(message.metadata?.activityTimeline?.length, 1)
  assert.equal(message.metadata?.sources?.length, 1)
  assert.equal(hasVisibleStructuredOutput(accumulator), true)
})

test("assistant session state omits empty structured fields and upserts by id", () => {
  const firstMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Partial" }),
    model: "anthropic/claude-sonnet-4.6",
    runMode: "chat",
    isStreaming: true,
  })
  const finalMessage = createAssistantMessageFromAccumulator({
    id: "assistant-1",
    createdAt: "2026-04-30T12:00:00.000Z",
    accumulator: createAccumulator({ content: "Final" }),
    model: "anthropic/claude-sonnet-4.6",
    runMode: "chat",
    isStreaming: false,
  })

  assert.equal("reasoning" in firstMessage.metadata, false)
  assert.equal(hasVisibleStructuredOutput(createAccumulator()), false)
  assert.deepEqual(upsertAgentMessage([], firstMessage), [firstMessage])
  assert.deepEqual(upsertAgentMessage([firstMessage], finalMessage), [
    finalMessage,
  ])
})

test("assistant session state prunes stale raw attachment payloads by thread", () => {
  const payloadsByThread = new Map()
  const threadPayloads = getThreadAttachmentPayloads(
    payloadsByThread,
    "thread-1"
  )
  threadPayloads.set("user-keep", [
    {
      id: "attachment-1",
      kind: "image",
      filename: "chart.png",
      mediaType: "image/png",
      sizeBytes: 5,
      detail: "auto",
      dataUrl: "data:image/png;base64,aGVsbG8=",
    },
  ])
  threadPayloads.set("user-drop", [
    {
      id: "attachment-2",
      kind: "pdf",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 5,
      dataUrl: "data:application/pdf;base64,aGVsbG8=",
    },
  ])

  pruneThreadAttachmentPayloads(payloadsByThread, "thread-1", [
    {
      id: "user-keep",
      role: "user",
      content: "Analyze this.",
      createdAt: "2026-04-30T12:00:00.000Z",
    },
  ])

  assert.equal(payloadsByThread.get("thread-1")?.has("user-keep"), true)
  assert.equal(payloadsByThread.get("thread-1")?.has("user-drop"), false)

  pruneThreadAttachmentPayloads(payloadsByThread, "thread-1", [])

  assert.equal(payloadsByThread.has("thread-1"), false)
})
