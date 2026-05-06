import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const gatewaySearchToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-gateway-search-tools.ts")
).href
const tavilyToolsPath = path.join(
  cwd,
  "src/lib/server/llm/ai-sdk-tavily-tools.ts"
)
const persistentSelectedModelUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-selected-model-utils.ts")
).href

const {
  getAiSdkGatewayProviderOptions,
  getAiSdkGatewayProviderOptionsForMode,
  getAiSdkGatewaySearchToolCallMetadata,
} = await import(gatewaySearchToolsUrl)
const {
  parseStoredSelectedModel,
  resolvePersistedSelectedModel,
  serializeStoredSelectedModel,
} = await import(persistentSelectedModelUrl)

test("gateway search tools normalize queries from native and gateway search inputs", () => {
  assert.deepEqual(
    getAiSdkGatewaySearchToolCallMetadata({
      toolCallId: "call-web",
      toolName: "web_search",
      input: { query: "latest vercel ai gateway updates" },
    }),
    {
      callId: "call-web",
      toolName: "web_search",
      label: "Searching Web",
      query: "latest vercel ai gateway updates",
      operation: "web_search",
      provider: "ai_gateway",
    }
  )

  assert.equal(
    getAiSdkGatewaySearchToolCallMetadata({
      toolCallId: "call-pplx",
      toolName: "perplexity_search",
      input: { query: ["vercel ai gateway", "claude sonnet 4.6"] },
    }),
    null
  )

  assert.equal(
    getAiSdkGatewaySearchToolCallMetadata({
      toolCallId: "call-parallel",
      toolName: "parallel_search",
      input: { objective: "Find recent AI Gateway launch coverage." },
    }),
    null
  )
})

test("tavily search tool results derive source links", async () => {
  const source = await readFile(tavilyToolsPath, "utf8")

  assert.match(
    source,
    /sources: payload\.output[\s\S]*toSourcesFromOutput\(toolName, payload\.output\)/,
    "Expected Tavily tool results to expose source links from successful search output."
  )
  assert.match(
    source,
    /id: `\$\{toolName\}-\$\{requestId\}-\$\{String\(index\)\}`/,
    "Expected Tavily source ids to be stable per tool call and result index."
  )
})

test("gateway provider options request the strongest supported reasoning levels", () => {
  assert.deepEqual(getAiSdkGatewayProviderOptions(), {
    anthropic: {
      sendReasoning: true,
      thinking: {
        type: "adaptive",
        display: "summarized",
      },
      effort: "high",
    },
  })

  assert.deepEqual(
    getAiSdkGatewayProviderOptionsForMode({ deepResearch: true }).openai,
    {
      reasoningEffort: "xhigh",
      reasoningSummary: "detailed",
      textVerbosity: "high",
    }
  )
})

test("inline citation instructions avoid separate sources sections", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      path.join(cwd, "src/lib/server/llm/system-instruction-augmentations.ts"),
      "utf8"
    )
  )

  assert.match(
    source,
    /Do not add a separate "Sources", "References", or bibliography section/,
    "Expected source-backed answers to rely on inline citations and Activity instead of a footer."
  )
})

test("stale and legacy default model ids fall back to GPT-5.5", () => {
  assert.equal(parseStoredSelectedModel("qwen/qwen3.6-plus"), null)
  assert.equal(parseStoredSelectedModel("anthropic/claude-sonnet-4.6"), null)
  assert.equal(
    parseStoredSelectedModel(
      JSON.stringify(
        serializeStoredSelectedModel("anthropic/claude-sonnet-4.6")
      )
    ),
    "anthropic/claude-sonnet-4.6"
  )

  assert.equal(
    resolvePersistedSelectedModel({
      storedModel: null,
      currentModel: null,
      initialSelectedModel: null,
      availableModels: [
        {
          id: "openai/gpt-5.5",
          name: "GPT-5.5",
        },
        {
          id: "anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
      ],
    }),
    "openai/gpt-5.5"
  )
})
