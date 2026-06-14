import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const providerOptionsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-gateway-provider-options.ts")
).href

const {
  getAiSdkGatewayProviderOptionsForMode,
  getAiSdkGatewayProviderOptionsForTaskMode,
} = await import(providerOptionsUrl)

test("getAiSdkGatewayProviderOptionsForMode preserves legacy deep-research behavior", () => {
  assert.deepEqual(getAiSdkGatewayProviderOptionsForMode(), {})
  assert.deepEqual(getAiSdkGatewayProviderOptionsForMode({}), {})
  assert.deepEqual(
    getAiSdkGatewayProviderOptionsForMode({ deepResearch: false }),
    {}
  )
  assert.deepEqual(
    getAiSdkGatewayProviderOptionsForMode({ deepResearch: true }),
    {
      google: {
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
      },
    }
  )
})

test("Gemini gets high thinking for research, high_stakes, debugging", () => {
  for (const taskMode of ["research", "high_stakes", "debugging"]) {
    assert.deepEqual(
      getAiSdkGatewayProviderOptionsForTaskMode({
        provider: "google",
        taskMode,
      }),
      {
        google: {
          thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
        },
      },
      `expected high thinking for ${taskMode}`
    )
  }
})

test("Gemini gets medium thinking for coding", () => {
  assert.deepEqual(
    getAiSdkGatewayProviderOptionsForTaskMode({
      provider: "google",
      taskMode: "coding",
    }),
    {
      google: {
        thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
      },
    }
  )
})

test("Gemini gets low thinking for format-sensitive modes", () => {
  for (const taskMode of ["instruction_following", "closed_answer"]) {
    assert.deepEqual(
      getAiSdkGatewayProviderOptionsForTaskMode({
        provider: "google",
        taskMode,
      }),
      {
        google: {
          thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
        },
      },
      `expected low thinking for ${taskMode}`
    )
  }
})

test("Gemini falls back to default thinking for general/writing", () => {
  for (const taskMode of ["general", "writing"]) {
    assert.deepEqual(
      getAiSdkGatewayProviderOptionsForTaskMode({
        provider: "google",
        taskMode,
      }),
      {},
      `expected empty provider options for ${taskMode}`
    )
  }
})

test("non-Gemini reasoning models receive no explicit provider options", () => {
  for (const taskMode of ["research", "coding", "debugging", "general"]) {
    for (const provider of ["alibaba", "moonshotai", "xiaomi"]) {
      assert.deepEqual(
        getAiSdkGatewayProviderOptionsForTaskMode({
          provider,
          taskMode,
        }),
        {},
        `expected empty provider options for ${provider}+${taskMode}`
      )
    }
  }
})
