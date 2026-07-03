import assert from "node:assert/strict"
import path from "node:path"
import { beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
  "./openai-agents-exa-tools": toProjectFileUrl(
    "tests/stubs/openai-agents-exa-tools.mjs"
  ),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
})

const { classifyGoblinsQuery } = await import(
  pathToFileURL(path.join(cwd, "src/lib/server/llm/goblins-triage.ts")).href
)

const baseUsage = {
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokensDetails: [],
}

const baseParams = {
  openAiApiKey: "openai-key",
  messages: [{ role: "user", content: "Compare A and B thoroughly." }],
  requestId: "req-triage",
}

beforeEach(() => {
  resetTestMocks()
})

test("classifier tier and suggestions are returned", async () => {
  setTestMocks({
    agents: {
      run: (agent) => {
        assert.equal(agent.options.name, "goblins-triage")
        return {
          finalOutput: {
            tier: "deep",
            suggestedGoblins: ["goblin_numbers_analyst"],
          },
          state: { usage: baseUsage },
        }
      },
    },
  })

  const result = await classifyGoblinsQuery(baseParams)
  assert.equal(result.tier.id, "deep")
  assert.equal(result.tier.evaluatorEnabled, true)
  assert.deepEqual(result.suggestedGoblins, ["goblin_numbers_analyst"])
  assert.equal(result.source, "classifier")
})

test("classifier failure falls back to the standard tier", async () => {
  setTestMocks({
    agents: {
      run: () => {
        throw new Error("model unavailable")
      },
    },
  })

  const result = await classifyGoblinsQuery(baseParams)
  assert.equal(result.tier.id, "standard")
  assert.equal(result.source, "fallback")
  assert.equal(result.suggestedGoblins, undefined)
})

test("malformed classifier output falls back to the standard tier", async () => {
  setTestMocks({
    agents: {
      run: () => ({
        finalOutput: { tier: "enormous" },
        state: { usage: baseUsage },
      }),
    },
  })

  const result = await classifyGoblinsQuery(baseParams)
  assert.equal(result.tier.id, "standard")
  assert.equal(result.source, "fallback")
})

test("empty messages fall back without calling the model", async () => {
  let called = false
  setTestMocks({
    agents: {
      run: () => {
        called = true
        return { finalOutput: { tier: "quick" }, state: { usage: baseUsage } }
      },
    },
  })

  const result = await classifyGoblinsQuery({ ...baseParams, messages: [] })
  assert.equal(result.source, "fallback")
  assert.equal(called, false)
})
