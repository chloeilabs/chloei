import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

// agent-runtime.ts pulls in @openai/agents (+ the Exa tools); stub them so we
// can import the pure compaction-settings helper.
setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
  "./openai-agents-exa-tools": toProjectFileUrl(
    "tests/stubs/openai-agents-exa-tools.mjs"
  ),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
})

const cwd = fileURLToPath(new URL("..", import.meta.url))
const { resolveContextManagementSettings } = await import(
  pathToFileURL(path.join(cwd, "src/lib/server/llm/agent-runtime.ts")).href
)

test("compaction settings are empty when the flag is off", () => {
  assert.deepEqual(resolveContextManagementSettings(false), {})
})

test("compaction settings enable a compaction strategy when the flag is on", () => {
  const settings = resolveContextManagementSettings(true)
  assert.equal(settings.contextManagement.length, 1)
  assert.equal(settings.contextManagement[0].type, "compaction")
  assert.equal(typeof settings.contextManagement[0].compactThreshold, "number")
  assert.ok(settings.contextManagement[0].compactThreshold > 0)
})
