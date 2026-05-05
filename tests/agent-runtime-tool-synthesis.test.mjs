import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-tool-synthesis.ts")
).href

const {
  buildToolSynthesisPrompt,
  getSourceBackedPromptQuery,
  shouldForceToolSynthesisStep,
} = await import(moduleUrl)

const sourcePromptMessages = [
  {
    role: "user",
    content:
      "Search the web for the latest Vercel AI Gateway documentation and summarize three facts with links.",
  },
]
const noSourcePromptMessages = [
  {
    role: "user",
    content:
      "Write a long answer about multi-step tool-calling agents. Do not use external sources.",
  },
]

function createStep(text) {
  return {
    text,
    toolResults: [{ toolName: "tavily_search" }],
  }
}

test("source prefetch respects explicit no-source prompts", () => {
  assert.equal(
    getSourceBackedPromptQuery("xai/grok-4.3", sourcePromptMessages),
    sourcePromptMessages[0].content
  )
  assert.equal(
    getSourceBackedPromptQuery("xai/grok-4.3", noSourcePromptMessages),
    null
  )
  assert.equal(
    getSourceBackedPromptQuery(
      "anthropic/claude-sonnet-4.6",
      sourcePromptMessages
    ),
    null
  )
})

test("xAI tool synthesis runs for partial sourced answers", () => {
  assert.equal(
    getSourceBackedPromptQuery("xai/grok-4.3", sourcePromptMessages),
    sourcePromptMessages[0].content
  )

  assert.equal(
    shouldForceToolSynthesisStep({
      model: "xai/grok-4.3",
      messages: sourcePromptMessages,
      steps: [createStep("Fact 1: Vercel AI Gateway provides routing.")],
      sourceCount: 2,
      textCharCount: 48,
      toolResultStatuses: new Map([["call-1", "success"]]),
    }),
    true
  )
})

test("xAI tool synthesis skips complete or non-xAI answers", () => {
  const completeText =
    "Fact 1: AI Gateway routes models with one API. https://vercel.com/docs/ai-gateway\n" +
    "Fact 2: It supports provider routing and observability. https://vercel.com/changelog\n" +
    "Fact 3: The docs include SDK usage and tool calling. https://vercel.com/docs\n" +
    "Additional context: ".repeat(40)

  assert.equal(
    shouldForceToolSynthesisStep({
      model: "xai/grok-4.3",
      messages: sourcePromptMessages,
      steps: [createStep(completeText)],
      sourceCount: 3,
      textCharCount: completeText.length,
      toolResultStatuses: new Map([["call-1", "success"]]),
    }),
    false
  )
  assert.equal(
    shouldForceToolSynthesisStep({
      model: "anthropic/claude-sonnet-4.6",
      messages: sourcePromptMessages,
      steps: [createStep("Fact 1 only.")],
      sourceCount: 1,
      textCharCount: 12,
      toolResultStatuses: new Map([["call-1", "success"]]),
    }),
    false
  )
})

test("tool synthesis prompt preserves the base instruction", () => {
  assert.match(buildToolSynthesisPrompt("base system"), /^base system\n\n/)
  assert.match(buildToolSynthesisPrompt("base system"), /Do not call tools/)
})
