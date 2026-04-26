import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"
import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const gatewaySearchToolsUrl = `${
  pathToFileURL(
    path.join(cwd, "src/lib/server/llm/ai-sdk-gateway-search-tools.ts")
  ).href
}?stubbed-anthropic=1`
const anthropicStubUrl = pathToFileURL(
  path.join(cwd, "tests/stubs/anthropic.mjs")
).href

setTestModuleStubs({
  "@ai-sdk/anthropic": toProjectFileUrl("tests/stubs/anthropic.mjs"),
})

const { createAiSdkGatewaySearchTools } = await import(gatewaySearchToolsUrl)
const { getAnthropicCalls, resetAnthropicCalls } = await import(
  anthropicStubUrl
)

test("gateway search tool factory uses the AI Gateway compatible Anthropic web search tool version", () => {
  resetAnthropicCalls()

  const tools = createAiSdkGatewaySearchTools({
    model: "anthropic/claude-sonnet-4.6",
    userTimeZone: "America/Chicago",
  })

  assert.deepEqual(getAnthropicCalls(), [
    {
      tool: "webSearch_20250305",
      options: {
        maxUses: 5,
        userLocation: {
          type: "approximate",
          timezone: "America/Chicago",
        },
      },
    },
  ])
  assert.equal(tools.web_search.type, "webSearch_20250305")
  assert.deepEqual(Object.keys(tools), ["web_search"])
})

test("gateway search tool factory skips the Anthropic web search tool for non-Anthropic models", () => {
  resetAnthropicCalls()

  const tools = createAiSdkGatewaySearchTools({
    model: "openai/gpt-5.5",
    userTimeZone: "America/Chicago",
  })

  assert.deepEqual(getAnthropicCalls(), [])
  assert.deepEqual(Object.keys(tools), [])
})
