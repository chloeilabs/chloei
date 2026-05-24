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
    resolvePromptProvider(AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW),
    "google"
  )
  assert.equal(
    resolvePromptProvider(AvailableModels.MOONSHOTAI_KIMI_K2_6),
    "moonshotai"
  )
  assert.equal(
    resolvePromptProvider(AvailableModels.XIAOMI_MIMO_V2_5_PRO),
    "xiaomi"
  )
})

test("prompt steering includes provider overlays for supported models", () => {
  const blocks = createPromptSteeringBlocks({
    provider: "google",
    taskMode: "research",
  })
  const overlayText = blocks.map((block) => block.body).join("\n\n")

  assert.match(
    overlayText,
    /Use Gemini reasoning mode efficiently/,
    "Expected Google prompts to receive the Gemini provider overlay."
  )
  assert.match(
    overlayText,
    /This request needs deep research/,
    "Expected research prompts to receive the research task overlay."
  )
})

test("prompt steering keeps finance guidance provider-agnostic", () => {
  const blocks = createPromptSteeringBlocks({
    provider: "xiaomi",
    taskMode: "finance_analysis",
  })
  const overlayText = blocks.map((block) => block.body).join("\n\n")

  assert.match(
    overlayText,
    /For ordinary public-company quote\/profile requests/,
    "Expected finance prompts to preserve shared provider-routing rules."
  )
  assert.match(
    overlayText,
    /For 10-K\/10-Q prompts/,
    "Expected finance prompts to preserve shared filing-routing rules."
  )
  assert.doesNotMatch(
    overlayText,
    /Return only the user-facing answer/,
    "Expected removed provider-specific finance guidance to stay out of supported prompts."
  )
})

test("prompt steering detects finance analysis without overriding personal advice safety", () => {
  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content:
          "Compare AAPL valuation using revenue, EBITDA, FCF, and recent 10-K data.",
      },
    ]),
    "finance_analysis"
  )

  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content:
          "Find the current quote and company profile for AAPL using structured finance data.",
      },
    ]),
    "finance_analysis"
  )

  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content: "What finance data providers are available right now?",
      },
    ]),
    "finance_analysis"
  )

  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content:
          "Analyze NVIDIA's latest 10-K cash flow, capital expenditures, total liabilities, and long-term debt.",
      },
    ]),
    "finance_analysis"
  )

  assert.equal(
    inferPromptTaskMode([
      {
        role: "user",
        content: "Should I buy this stock in my retirement account?",
      },
    ]),
    "high_stakes"
  )
})
