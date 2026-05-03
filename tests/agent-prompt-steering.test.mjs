import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/models.ts")
).href
const systemPromptsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/system-prompts.ts")
).href
const steeringUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-prompt-steering.ts")
).href

const { AvailableModels } = await import(modelsUrl)
const { createPromptSteeringBlocks } = await import(systemPromptsUrl)
const { inferPromptTaskMode, resolvePromptProvider } = await import(steeringUrl)

test("prompt steering resolves supported model providers", () => {
  assert.equal(
    resolvePromptProvider(AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6),
    "anthropic"
  )
  assert.equal(resolvePromptProvider(AvailableModels.OPENAI_GPT_5_5), "openai")
  assert.equal(
    resolvePromptProvider(AvailableModels.MOONSHOTAI_KIMI_K2_6),
    "moonshotai"
  )
  assert.equal(
    resolvePromptProvider(AvailableModels.DEEPSEEK_V4_PRO),
    "deepseek"
  )
  assert.equal(resolvePromptProvider(AvailableModels.XAI_GROK_4_3), "xai")
})

test("prompt steering tells Grok to complete tool-backed news answers", () => {
  const blocks = createPromptSteeringBlocks({
    provider: "xai",
    taskMode: "research",
  })
  const overlayText = blocks.map((block) => block.body).join("\n\n")

  assert.match(
    overlayText,
    /complete final response in one pass/,
    "Expected Grok news and research requests to avoid early final-answer stops."
  )
  assert.match(
    overlayText,
    /Do not stop after the first section/,
    "Expected Grok to avoid one-section partial news answers."
  )
})

test("prompt steering tells Grok finance to use prefetched evidence", () => {
  const blocks = createPromptSteeringBlocks({
    provider: "xai",
    taskMode: "finance_analysis",
  })
  const overlayText = blocks.map((block) => block.body).join("\n\n")

  assert.match(
    overlayText,
    /structured finance evidence supplied in the prompt/,
    "Expected Grok finance prompts to rely on server-prefetched evidence."
  )
  assert.match(
    overlayText,
    /Return only the user-facing answer/,
    "Expected Grok finance prompts to suppress visible planning text."
  )
  assert.doesNotMatch(
    overlayText,
    /call `finance_data`/,
    "Expected Grok finance prompts to avoid model-driven finance tool calls."
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
