import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const threadsPath = path.join(cwd, "src/lib/server/threads.ts")
const helperPath = path.join(cwd, "src/lib/server/thread-payload.ts")

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
