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
const {
  createPromptSteeringBlocks,
  inferPromptTaskMode,
  resolvePromptProvider,
} = await import(steeringUrl)

test("prompt steering resolves supported model providers", () => {
  assert.equal(
    resolvePromptProvider(AvailableModels.ALIBABA_QWEN3_7_MAX),
    "alibaba"
  )
  assert.equal(
    resolvePromptProvider(AvailableModels.MOONSHOTAI_KIMI_K2_6),
    "moonshotai"
  )
})

test("prompt steering includes provider overlays for supported models", () => {
  const blocks = createPromptSteeringBlocks({
    provider: "moonshotai",
    taskMode: "research",
  })
  const overlayText = blocks.map((block) => block.body).join("\n\n")

  assert.match(
    overlayText,
    /Use Kimi reasoning mode efficiently/,
    "Expected Moonshot AI prompts to receive the Kimi provider overlay."
  )
  assert.match(
    overlayText,
    /This request needs deep research/,
    "Expected research prompts to receive the research task overlay."
  )
})

test("prompt steering routes personal financial advice to high_stakes", () => {
  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content: "Should I buy this stock in my retirement account?",
      },
    ]),
    "high_stakes"
  )

  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content: "Help me plan tax deductions for my LLC this year.",
      },
    ]),
    "high_stakes"
  )
})
