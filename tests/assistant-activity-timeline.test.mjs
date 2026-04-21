import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/messages/assistant-activity-timeline.ts")
).href

const { normalizeAssistantActivityTimeline, normalizeThinkingEntry } =
  await import(moduleUrl)

test("normalizeThinkingEntry strips leading reasoning labels", () => {
  assert.equal(
    normalizeThinkingEntry("THINKING\nThe user wants current AI news."),
    "The user wants current AI news."
  )

  assert.equal(
    normalizeThinkingEntry("Reasoning: The user wants current AI news."),
    "The user wants current AI news."
  )

  assert.equal(normalizeThinkingEntry("THINKING:"), "")
  assert.equal(normalizeThinkingEntry("Reasoning"), "")
})

test("normalizeAssistantActivityTimeline preserves streamed event order", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-1",
    role: "assistant",
    content: "",
    llmModel: "anthropic/claude-sonnet-4.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "reasoning-1",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          text: "First pass",
        },
        {
          id: "search-1",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-1",
          toolName: "web_search",
          label: "latest ai news",
          status: "running",
        },
        {
          id: "sources-1",
          kind: "sources",
          order: 2,
          createdAt: "2026-04-20T12:00:02.000Z",
          sources: [
            {
              id: "source-1",
              title: "AI News",
              url: "https://example.com/ai-news",
            },
          ],
        },
        {
          id: "reasoning-2",
          kind: "reasoning",
          order: 3,
          createdAt: "2026-04-20T12:00:03.000Z",
          text: "Second pass",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.kind),
    ["reasoning", "search", "sources", "reasoning"]
  )

  assert.deepEqual(timeline[1], {
    id: "search-1",
    kind: "search",
    order: 1,
    createdAt: "2026-04-20T12:00:01.000Z",
    callId: "call-1",
    toolName: "web_search",
    query: "latest ai news",
    status: "running",
  })
})

test("normalizeAssistantActivityTimeline appends missing sources after legacy fallback entries", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-2",
    role: "assistant",
    content: "",
    llmModel: "anthropic/claude-sonnet-4.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      reasoning: "Look up results",
      toolInvocations: [
        {
          id: "tool-1",
          callId: "call-1",
          toolName: "web_search",
          label: "latest ai news",
          query: "latest ai news",
          status: "success",
        },
      ],
      sources: [
        {
          id: "source-1",
          title: "AI News",
          url: "https://example.com/ai-news",
        },
        {
          id: "source-2",
          title: "AI News duplicate",
          url: "https://example.com/ai-news",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.kind),
    ["reasoning", "search", "sources"]
  )

  const sourcesEntry = timeline[2]
  assert.equal(sourcesEntry?.kind, "sources")
  assert.deepEqual(sourcesEntry?.sources, [
    {
      id: "source-1",
      title: "AI News",
      url: "https://example.com/ai-news",
    },
  ])
})
