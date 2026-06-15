import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const threadsPath = path.join(cwd, "src/lib/server/threads.ts")
const helperPath = path.join(cwd, "src/lib/server/thread-payload.ts")
const helperUrl = pathToFileURL(helperPath).href

const { parseThreadPayload } = await import(helperUrl)

test("thread payload helper preserves legacy activity timeline conversion", async () => {
  const source = await readFile(helperPath, "utf8")

  assert.match(
    source,
    /legacyCrewStatusActivityTimelineEntrySchema[\s\S]*legacyTaskProgressActivityTimelineEntrySchema[\s\S]*legacyAgentSwitchActivityTimelineEntrySchema/,
    "Expected the payload helper to retain legacy activity timeline schemas."
  )

  assert.match(
    source,
    /kind: "reasoning" as const[\s\S]*kind: "reasoning" as const[\s\S]*kind: "reasoning" as const/,
    "Expected legacy activity timeline entries to normalize into reasoning entries."
  )
})

test("thread payload sanitizes private prompt terminology in reasoning", () => {
  const parsed = parseThreadPayload({
    id: "thread-private-reasoning",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "Done.",
        llmModel: "moonshotai/kimi-k2.6",
        createdAt: "2026-04-26T00:00:00.000Z",
        metadata: {
          reasoning: "Use SOUL.md and the system prompt.",
          activityTimeline: [
            {
              id: "reasoning-1",
              kind: "reasoning",
              order: 0,
              createdAt: "2026-04-26T00:00:00.000Z",
              text: "Follow SHARED CONTEXT FILE: SOUL.md.",
            },
          ],
        },
      },
    ],
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
  })

  assert.equal(
    parsed.messages[0].metadata.reasoning,
    "Use private identity guidance and the private instructions."
  )
  assert.equal(
    parsed.messages[0].metadata.activityTimeline[0].text,
    "Follow private identity guidance."
  )
})

test("thread payload truncates sanitized activity reasoning to the schema limit", () => {
  const rawText = `SOUL.md ${"x".repeat(100_000 - "SOUL.md ".length)}`
  const parsed = parseThreadPayload({
    id: "thread-long-sanitized-reasoning",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "Done.",
        llmModel: "moonshotai/kimi-k2.6",
        createdAt: "2026-04-26T00:00:00.000Z",
        metadata: {
          activityTimeline: [
            {
              id: "reasoning-1",
              kind: "reasoning",
              order: 0,
              createdAt: "2026-04-26T00:00:00.000Z",
              text: rawText,
            },
          ],
        },
      },
    ],
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
  })

  const text = parsed.messages[0].metadata.activityTimeline[0].text

  assert.equal(text.length, 100_000)
  assert.equal(text.startsWith("private identity guidance "), true)
})

test("thread store delegates parsing and persistence shaping to the payload helper", async () => {
  const source = await readFile(threadsPath, "utf8")

  assert.match(
    source,
    /from "\.\/thread-payload"/,
    "Expected the thread store to depend on the extracted payload helper."
  )

  assert.match(
    source,
    /threads\.push\(parseStoredThread\(row\)\)/,
    "Expected stored row parsing to delegate to parseStoredThread."
  )

  assert.match(
    source,
    /prepareThreadForPersistence\(thread\)/,
    "Expected persistence shaping to delegate to prepareThreadForPersistence."
  )
})

test("thread payload drops legacy run-mode metadata from stored threads", () => {
  const parsed = parseThreadPayload({
    id: "thread-1",
    model: "google/gemini-3.1-pro-preview",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "Research this.",
        llmModel: "moonshotai/kimi-k2.6",
        createdAt: "2026-04-26T00:00:00.000Z",
        metadata: {
          selectedModel: "moonshotai/kimi-k2.6",
          runMode: "research",
        },
      },
    ],
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:01.000Z",
  })

  assert.equal(
    parsed.messages[0]?.metadata?.selectedModel,
    "moonshotai/kimi-k2.6"
  )
  assert.equal(parsed.messages[0]?.metadata?.runMode, undefined)
})
