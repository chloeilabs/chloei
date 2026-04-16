import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

const sharedThreadsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/threads.ts")
).href
const threadPayloadUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/thread-payload.ts")
).href

const { deriveThreadTitle, normalizeThread, sortThreadsNewestFirst } =
  await import(sharedThreadsUrl)
const { parseStoredThread, parseThreadPayload, prepareThreadForPersistence } =
  await import(
  threadPayloadUrl
)

function createMessage(overrides = {}) {
  return {
    id: "message-1",
    role: "user",
    content: "First question about streaming behavior",
    llmModel: "qwen/qwen3.6-plus",
    createdAt: "2026-04-15T10:00:00.000Z",
    ...overrides,
  }
}

test("thread helpers derive titles, normalize pinned state, and sort predictably", () => {
  assert.equal(
    deriveThreadTitle([createMessage({ content: "   Hello from the first prompt   " })]),
    "Hello from the first prompt"
  )

  const normalized = normalizeThread({
    id: "thread-1",
    title: "   ",
    messages: [createMessage({ content: "   Derived title from content   " })],
    createdAt: "2026-04-15T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
  })

  assert.equal(normalized.title, "Derived title from content")
  assert.equal(normalized.isPinned, false)

  const sortedIds = sortThreadsNewestFirst([
    {
      id: "b",
      title: "Older pinned",
      messages: [createMessage()],
      isPinned: true,
      createdAt: "2026-04-15T08:00:00.000Z",
      updatedAt: "2026-04-15T08:00:00.000Z",
    },
    {
      id: "a",
      title: "Newest unpinned",
      messages: [createMessage()],
      isPinned: false,
      createdAt: "2026-04-15T12:00:00.000Z",
      updatedAt: "2026-04-15T12:00:00.000Z",
    },
    {
      id: "c",
      title: "Newest pinned",
      messages: [createMessage()],
      isPinned: true,
      createdAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:00:00.000Z",
    },
  ]).map((thread) => thread.id)

  assert.deepEqual(sortedIds, ["c", "b", "a"])
})

test("parseThreadPayload sanitizes invalid metadata and converts legacy activity entries", () => {
  const parsed = parseThreadPayload({
    id: "thread-legacy",
    title: "   ",
    model: "not-a-model",
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Summarize this thread",
        llmModel: "qwen/qwen3.6-plus",
        createdAt: "2026-04-15T10:00:00.000Z",
        metadata: {
          selectedModel: "not-a-model",
          interactionId: "   ",
          lastEventId: " last-event-1 ",
          toolInvocations: [
            {
              id: "tool-1",
              callId: "call-1",
              toolName: "web_search",
              label: " Search ",
              status: "success",
            },
            {
              id: "tool-2",
              callId: "call-2",
              toolName: "not-a-tool",
              label: "Bad tool",
              status: "success",
            },
          ],
          activityTimeline: [
            {
              id: "legacy-1",
              kind: "crew_status",
              order: 0,
              createdAt: "2026-04-15T10:00:01.000Z",
              status: "started",
              crewName: "crew",
            },
            {
              id: "invalid-activity",
              kind: "tool",
              order: 1,
              createdAt: "2026-04-15T10:00:02.000Z",
            },
          ],
          sources: [
            {
              id: "source-1",
              url: "https://example.com",
              title: "Example",
            },
            {
              id: "",
              url: "https://bad.example.com",
              title: "",
            },
          ],
        },
      },
    ],
    createdAt: "2026-04-15T11:00:00.000Z",
    updatedAt: "2026-04-15T11:05:00.000Z",
  })

  assert.equal(parsed.title, "Summarize this thread")
  assert.equal(parsed.model, undefined)
  assert.equal(parsed.isPinned, false)
  assert.equal(parsed.messages[0]?.metadata?.selectedModel, undefined)
  assert.equal(parsed.messages[0]?.metadata?.interactionId, undefined)
  assert.equal(parsed.messages[0]?.metadata?.lastEventId, "last-event-1")
  assert.deepEqual(parsed.messages[0]?.metadata?.toolInvocations, [
    {
      id: "tool-1",
      callId: "call-1",
      toolName: "web_search",
      label: "Search",
      status: "success",
    },
  ])
  assert.deepEqual(parsed.messages[0]?.metadata?.activityTimeline, [
    {
      id: "legacy-1",
      kind: "reasoning",
      order: 0,
      createdAt: "2026-04-15T10:00:01.000Z",
      text: "Crew started.",
    },
  ])
  assert.deepEqual(parsed.messages[0]?.metadata?.sources, [
    {
      id: "source-1",
      url: "https://example.com",
      title: "Example",
    },
  ])
})

test("prepareThreadForPersistence aligns createdAt with the first message and trims the persisted title", () => {
  const { normalizedThread, title } = prepareThreadForPersistence({
    id: "thread-persist",
    title: "   Explicit title that should be trimmed   ",
    model: "qwen/qwen3.6-plus",
    isPinned: true,
    messages: [
      createMessage({
        createdAt: "2026-04-15T09:59:00.000Z",
      }),
    ],
    createdAt: "2026-04-15T12:00:00.000Z",
    updatedAt: "2026-04-15T12:05:00.000Z",
  })

  assert.equal(normalizedThread.createdAt, "2026-04-15T09:59:00.000Z")
  assert.equal(title, "Explicit title that should be trimmed")
  assert.equal(normalizedThread.isPinned, true)
})

test("parseStoredThread normalizes stored rows with Date timestamps", () => {
  const parsed = parseStoredThread({
    id: "stored-thread-1",
    title: "   ",
    model: null,
    isPinned: null,
    messages: [
      createMessage({
        content: "  Persisted title from the first message  ",
        createdAt: "2026-04-15T09:00:00.000Z",
      }),
    ],
    createdAt: new Date("2026-04-15T12:00:00.000Z"),
    updatedAt: new Date("2026-04-15T12:05:00.000Z"),
  })

  assert.equal(parsed.title, "Persisted title from the first message")
  assert.equal(parsed.model, undefined)
  assert.equal(parsed.isPinned, false)
  assert.equal(parsed.createdAt, "2026-04-15T09:00:00.000Z")
  assert.equal(parsed.updatedAt, "2026-04-15T12:05:00.000Z")
})

test("parseStoredThread throws when stored row timestamps are invalid", () => {
  assert.throws(
    () =>
      parseStoredThread({
        id: "stored-thread-2",
        title: "Bad timestamp",
        model: null,
        isPinned: false,
        messages: [createMessage()],
        createdAt: "not-a-date",
        updatedAt: "2026-04-15T12:05:00.000Z",
      }),
    /Invalid thread timestamp/
  )
})
