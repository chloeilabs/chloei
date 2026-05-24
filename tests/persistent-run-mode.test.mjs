import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const persistentRunModeUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-run-mode-utils.ts")
).href
const persistentRunModeHookPath = path.join(
  cwd,
  "src/hooks/agent/use-persistent-run-mode.tsx"
)

const { parseStoredRunMode, resolvePersistedRunMode, serializeStoredRunMode } =
  await import(persistentRunModeUrl)

test("persistent run mode parses only supported modes", () => {
  assert.equal(parseStoredRunMode("research"), "research")
  assert.equal(parseStoredRunMode("chat"), "chat")
  assert.equal(parseStoredRunMode("browse"), null)
  assert.equal(parseStoredRunMode(null), null)
})

test("persistent run mode parses current stored payload shape", () => {
  assert.equal(
    parseStoredRunMode(JSON.stringify(serializeStoredRunMode("research"))),
    "research"
  )
  assert.equal(
    parseStoredRunMode(
      JSON.stringify({
        runMode: "research",
        source: "system",
        version: 1,
      })
    ),
    null
  )
})

test("persistent run mode prefers stored mode over current and fallback", () => {
  assert.equal(
    resolvePersistedRunMode({
      storedRunMode: "research",
      currentRunMode: "chat",
      fallbackRunMode: "chat",
    }),
    "research"
  )
  assert.equal(
    resolvePersistedRunMode({
      storedRunMode: null,
      currentRunMode: "research",
      fallbackRunMode: "chat",
    }),
    "research"
  )
  assert.equal(
    resolvePersistedRunMode({
      storedRunMode: null,
    }),
    "chat"
  )
})

test("persistent run mode hook guards restricted storage access", async () => {
  const source = await readFile(persistentRunModeHookPath, "utf8")

  assert.match(
    source,
    /try \{\s+storedValue = window\.localStorage\.getItem\(RUN_MODE_STORAGE_KEY\)/,
    "Expected persisted run mode reads to guard localStorage access."
  )
  assert.match(
    source,
    /try \{\s+window\.localStorage\.setItem\(\s+RUN_MODE_STORAGE_KEY,/,
    "Expected persisted run mode writes to guard localStorage access."
  )
  assert.match(
    source,
    /try \{\s+window\.dispatchEvent\(new CustomEvent\(RUN_MODE_UPDATED_EVENT\)\)/,
    "Expected persisted run mode updates to guard event dispatch."
  )
})
