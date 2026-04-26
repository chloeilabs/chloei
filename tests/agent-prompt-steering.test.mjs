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
const { inferPromptTaskMode, resolvePromptProvider } = await import(steeringUrl)

test("prompt steering resolves Anthropic and OpenAI providers", () => {
  assert.equal(
    resolvePromptProvider(AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6),
    "anthropic"
  )
  assert.equal(resolvePromptProvider(AvailableModels.OPENAI_GPT_5_5), "openai")
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
