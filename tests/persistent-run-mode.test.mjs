import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const persistentRunModeUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-run-mode-utils.ts")
).href

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
