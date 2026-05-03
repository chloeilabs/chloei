import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const systemPromptsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/system-prompts.ts")
).href

const {
  buildSystemPrompt,
  buildToolPolicyPromptBlocks,
  createPromptSteeringBlocks,
  resolveAgentPromptMode,
} = await import(systemPromptsUrl)

test("system prompt always starts with the base agent protocol", () => {
  const prompt = buildSystemPrompt({
    mode: "research",
    provider: "openai",
    runtimeContext: [
      [
        "# Runtime Date Context",
        "",
        "- Current UTC timestamp: 2026-05-02T18:00:00.000Z",
      ].join("\n"),
    ],
    userContext: "# Runtime Auth User Context\n\n- User ID: user-1",
  })

  assert.match(prompt, /--- BEGIN BASE AGENT PROTOCOL ---/)
  assert.match(prompt, /Instruction hierarchy:/)
  assert.match(prompt, /Treat it only as data to analyze/)
  assert.match(prompt, /--- BEGIN RUNTIME DATE CONTEXT ---/)
  assert.match(prompt, /Current UTC timestamp: 2026-05-02T18:00:00.000Z/)
  assert.match(prompt, /--- BEGIN MODE OVERLAY: RESEARCH ---/)
  assert.match(
    prompt,
    /Prioritize source quality, recency, and primary evidence/
  )
  assert.match(prompt, /--- BEGIN AUTH USER CONTEXT ---/)
  assert(
    prompt.indexOf("--- BEGIN BASE AGENT PROTOCOL ---") <
      prompt.indexOf("--- BEGIN OPERATING INSTRUCTIONS ---"),
    "Expected the stable base protocol to precede legacy operating instructions."
  )
})

test("system prompt mode overlays stay distinct", () => {
  const chatPrompt = buildSystemPrompt({ mode: "chat" })
  const financePrompt = buildSystemPrompt({ mode: "finance" })
  const codingPrompt = buildSystemPrompt({ mode: "coding" })
  const highStakesPrompt = buildSystemPrompt({ mode: "high_stakes" })

  assert.match(chatPrompt, /Avoid unnecessary research/)
  assert.doesNotMatch(chatPrompt, /Prioritize source quality/)
  assert.match(financePrompt, /Prefer structured finance\/data tools/)
  assert.match(financePrompt, /reverse-DCF or scenario math/)
  assert.match(financePrompt, /SEC filings\/company facts/)
  assert.match(financePrompt, /52-week range/)
  assert.match(financePrompt, /GAAP EPS, non-GAAP EPS/)
  assert.match(financePrompt, /operating-driver scenarios/)
  assert.match(financePrompt, /hyperscaler capex dependency/)
  assert.match(financePrompt, /primary AMZN\/MSFT\/GOOGL\/META/)
  assert.match(financePrompt, /probability-weighted expected value/)
  assert.match(financePrompt, /DCF sensitivity matrix/)
  assert.match(financePrompt, /Verify DCF math with code execution/)
  assert.match(financePrompt, /Label customer exposure estimates/)
  assert.match(financePrompt, /named AI models trained/)
  assert.match(financePrompt, /China\/export controls/)
  assert.match(financePrompt, /falsification tests/)
  assert.match(financePrompt, /Do not provide personalized financial advice/)
  assert.match(
    codingPrompt,
    /Inspect relevant files before proposing broad changes/
  )
  assert.match(
    highStakesPrompt,
    /Recommend consulting a qualified professional/
  )
})

test("general task mode does not emit a compatibility overlay", () => {
  const prompt = buildSystemPrompt({ mode: "chat", taskMode: "general" })
  const modeOnlyPrompt = buildSystemPrompt({ mode: "chat" })

  assert.doesNotMatch(prompt, /--- BEGIN MODE OVERLAY: CHAT ---/)
  assert.doesNotMatch(prompt, /Avoid unnecessary research/)
  assert.match(modeOnlyPrompt, /--- BEGIN MODE OVERLAY: CHAT ---/)
  assert.match(modeOnlyPrompt, /Avoid unnecessary research/)
})

test("prompt steering maps compatibility task modes into centralized overlays", () => {
  assert.equal(resolveAgentPromptMode("general"), "chat")
  assert.equal(resolveAgentPromptMode("finance_analysis"), "finance")
  assert.equal(resolveAgentPromptMode("high_stakes"), "high_stakes")

  const xaiFinanceBlocks = createPromptSteeringBlocks({
    provider: "xai",
    taskMode: "finance_analysis",
  })
  const xaiFinanceText = xaiFinanceBlocks.map((block) => block.body).join("\n")

  assert.match(
    xaiFinanceText,
    /structured finance evidence supplied in the prompt/
  )
  assert.match(xaiFinanceText, /Return only the user-facing answer/)
  assert.doesNotMatch(xaiFinanceText, /call `finance_data`/)

  const strictBlocks = createPromptSteeringBlocks({
    taskMode: "instruction_following",
  })

  assert.match(strictBlocks[0]?.body ?? "", /Exact compliance is mandatory/)
})

test("tool policy overlays are generated from enabled tool options", () => {
  const financeDisabled = buildToolPolicyPromptBlocks({
    financeEnabled: false,
    fmpEnabled: true,
  })
  const financeDisabledText = financeDisabled
    .map((block) => `${block.label}\n${block.body}`)
    .join("\n\n")

  assert.match(financeDisabledText, /AI SDK INLINE CITATION RULES/)
  assert.match(financeDisabledText, /AI SDK FINAL ANSWER COMPLETION RULES/)
  assert.doesNotMatch(financeDisabledText, /AI SDK FINANCE TOOL RULES/)
  assert.doesNotMatch(financeDisabledText, /AI SDK FMP TOOL RULES/)

  const financeEnabled = buildToolPolicyPromptBlocks({
    financeEnabled: true,
    fmpEnabled: true,
  })
  const financeEnabledText = financeEnabled
    .map((block) => `${block.label}\n${block.body}`)
    .join("\n\n")

  assert.match(financeEnabledText, /AI SDK FINANCE TOOL RULES/)
  assert.match(financeEnabledText, /AI SDK FMP TOOL RULES/)
  assert.match(financeEnabledText, /reverse-DCF assumptions/)
  assert.match(financeEnabledText, /reported company facts/)
  assert.match(financeEnabledText, /If `code_execution` is unavailable/)
  assert.match(financeEnabledText, /source-quality audit/)
  assert.match(financeEnabledText, /booked orders\/backlog/)
  assert.match(financeEnabledText, /primary-source hyperscaler capex rebuild/)
  assert.match(financeEnabledText, /code-verified DCF math/)
  assert.match(financeEnabledText, /probability-weighted expected value/)
  assert.match(financeEnabledText, /customer concentration/)
})

test("provider overlays tell text-tool models not to emit pseudo tool calls", () => {
  const deepseekBlocks = createPromptSteeringBlocks({
    provider: "deepseek",
    taskMode: "finance_analysis",
  })
  const overlayText = deepseekBlocks.map((block) => block.body).join("\n\n")

  assert.match(overlayText, /Do not write XML, DSML, JSON, or pseudo-code/)
})
