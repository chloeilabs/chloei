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

test("normalizeThinkingEntry preserves prose that starts with Thinking/Reasoning", () => {
  assert.equal(
    normalizeThinkingEntry("Thinking about the latest figures."),
    "Thinking about the latest figures."
  )

  assert.equal(
    normalizeThinkingEntry("Reasoning through the trade-offs"),
    "Reasoning through the trade-offs"
  )
})

test("normalizeAssistantActivityTimeline preserves streamed event order", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-1",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
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
          toolName: "tavily_search",
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
    toolName: "tavily_search",
    query: "latest ai news",
    status: "running",
  })
})

test("normalizeAssistantActivityTimeline repairs legacy reasoning spacing from aggregate reasoning", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-legacy-spacing",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      reasoning:
        "Let me get current quotes/financial data for SCHD.\n\nThe quote returned MSFT.",
      activityTimeline: [
        {
          id: "reasoning-1",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          text: "Let me get current quotes/fin ancial data for SCH D.",
        },
        {
          id: "search-1",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-1",
          toolName: "tavily_search",
          label: "latest quote",
          status: "running",
        },
        {
          id: "reasoning-2",
          kind: "reasoning",
          order: 2,
          createdAt: "2026-04-20T12:00:02.000Z",
          text: "The quote returned MS FT.",
        },
      ],
    },
  })

  assert.equal(timeline[0]?.kind, "reasoning")
  assert.equal(
    timeline[0]?.text,
    "Let me get current quotes/financial data for SCHD."
  )
  assert.equal(timeline[1]?.kind, "search")
  assert.equal(timeline[2]?.kind, "reasoning")
  assert.equal(timeline[2]?.text, "The quote returned MSFT.")
})

test("normalizeAssistantActivityTimeline repairs spacing around non-BMP characters", () => {
  const rocket = "\u{1F680}"
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-legacy-non-bmp",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      reasoning: `Review ${rocket}financial data for MSFT.`,
      activityTimeline: [
        {
          id: "reasoning-1",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          text: `Review ${rocket}fin ancial data for MS FT.`,
        },
      ],
    },
  })

  assert.equal(timeline[0]?.kind, "reasoning")
  assert.equal(timeline[0]?.text, `Review ${rocket}financial data for MSFT.`)
})

test("normalizeAssistantActivityTimeline skips redacted entries before aggregate repair", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-redacted-repair",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      reasoning: "Visible repaired text for MSFT.",
      activityTimeline: [
        {
          id: "reasoning-redacted",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          text: "[REDACTED]",
        },
        {
          id: "reasoning-visible",
          kind: "reasoning",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          text: "Visible repaired text for MS FT.",
        },
      ],
    },
  })

  assert.equal(timeline.length, 1)
  assert.equal(timeline[0]?.kind, "reasoning")
  assert.equal(timeline[0]?.text, "Visible repaired text for MSFT.")
})

test("normalizeAssistantActivityTimeline sanitizes private prompt terminology", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-private-prompt",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "reasoning-private",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          text: "Use SOUL.md and the system prompt.",
        },
      ],
    },
  })

  assert.equal(timeline[0]?.kind, "reasoning")
  assert.equal(
    timeline[0]?.text,
    "Use private identity guidance and the private instructions."
  )
})

test("normalizeAssistantActivityTimeline appends missing sources after legacy fallback entries", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-2",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      reasoning: "Look up results",
      toolInvocations: [
        {
          id: "tool-1",
          callId: "call-1",
          toolName: "tavily_search",
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

test("normalizeAssistantActivityTimeline hides tool errors superseded by a later success", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-recovered-tool",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "tool-error",
          kind: "tool",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          callId: "call-1",
          toolName: "sec_filings",
          label: "Extracting SEC filing tables",
          query: "0001065280-25-000044 | issuer purchases",
          operation: "table_extract",
          status: "error",
          errorCode: "INVALID_INPUT",
        },
        {
          id: "tool-success",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-2",
          toolName: "sec_filings",
          label: "Extracting SEC filing tables",
          query: "0001065280-25-000044 | issuer purchases",
          operation: "table_extract",
          status: "success",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.id),
    ["tool-success"]
  )
})

test("normalizeAssistantActivityTimeline keeps unresolved tool errors visible", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-unresolved-tool",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "tool-error",
          kind: "tool",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          callId: "call-1",
          toolName: "sec_filings",
          label: "Extracting SEC filing section",
          operation: "section_extract",
          status: "error",
          errorCode: "SEC_SECTION_NOT_FOUND",
        },
        {
          id: "other-tool-success",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-2",
          toolName: "sec_filings",
          label: "Retrieving SEC filing evidence",
          operation: "retrieve_information",
          status: "success",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.id),
    ["tool-error", "other-tool-success"]
  )
})

test("normalizeAssistantActivityTimeline keeps SEC errors for different filing queries visible", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-distinct-sec-tools",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "tool-error",
          kind: "tool",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          callId: "call-1",
          toolName: "sec_filings",
          label: "Extracting SEC filing tables",
          query: "0001065280-25-000044 | issuer purchases",
          operation: "table_extract",
          status: "error",
          errorCode: "SEC_TABLE_NOT_FOUND",
        },
        {
          id: "tool-success",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-2",
          toolName: "sec_filings",
          label: "Extracting SEC filing tables",
          query: "0001065280-26-000034 | issuer purchases",
          operation: "table_extract",
          status: "success",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.id),
    ["tool-error", "tool-success"]
  )
})

test("normalizeAssistantActivityTimeline keeps finance errors for different input queries visible", () => {
  const timeline = normalizeAssistantActivityTimeline({
    id: "assistant-distinct-finance-tools",
    role: "assistant",
    content: "",
    llmModel: "moonshotai/kimi-k2.6",
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      activityTimeline: [
        {
          id: "tool-error",
          kind: "tool",
          order: 0,
          createdAt: "2026-04-20T12:00:00.000Z",
          callId: "call-1",
          toolName: "finance_data",
          label: "Finance: Quote",
          query: "AAPL",
          operation: "quote",
          status: "error",
          errorCode: "HTTP_404",
        },
        {
          id: "tool-success",
          kind: "tool",
          order: 1,
          createdAt: "2026-04-20T12:00:01.000Z",
          callId: "call-2",
          toolName: "finance_data",
          label: "Finance: Quote",
          query: "MSFT",
          operation: "quote",
          status: "success",
        },
      ],
    },
  })

  assert.deepEqual(
    timeline.map((entry) => entry.id),
    ["tool-error", "tool-success"]
  )
})
