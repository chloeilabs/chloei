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

test("thread payload preserves valid run modes and drops invalid run modes", () => {
  const parsed = parseThreadPayload({
    id: "thread-1",
    model: "openai/gpt-5.5",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "Research this.",
        llmModel: "anthropic/claude-sonnet-4.6",
        createdAt: "2026-04-26T00:00:00.000Z",
        metadata: {
          selectedModel: "anthropic/claude-sonnet-4.6",
          runMode: "research",
        },
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Done.",
        llmModel: "openai/gpt-5.5",
        createdAt: "2026-04-26T00:00:01.000Z",
        metadata: {
          runMode: "invalid",
        },
      },
    ],
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:01.000Z",
  })

  assert.equal(parsed.messages[0]?.metadata?.runMode, "research")
  assert.equal(parsed.messages[1]?.metadata?.runMode, undefined)
})
