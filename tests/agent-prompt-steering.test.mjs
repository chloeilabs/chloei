import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/models.ts")
).href
const steeringUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-prompt-steering.ts")
).href

const { AvailableModels } = await import(modelsUrl)
const { resolvePromptProvider } = await import(steeringUrl)

test("prompt steering resolves Anthropic and OpenAI providers", () => {
  assert.equal(
    resolvePromptProvider(AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6),
    "anthropic"
  )
  assert.equal(resolvePromptProvider(AvailableModels.OPENAI_GPT_5_5), "openai")
})
