import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const gatewaySearchToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-gateway-search-tools.ts")
).href
const persistentSelectedModelUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-selected-model-utils.ts")
).href

const {
  getAiSdkGatewayProviderOptions,
  getAiSdkGatewayProviderOptionsForMode,
  getAiSdkGatewaySearchToolCallMetadata,
  getAiSdkGatewaySearchToolResultMetadata,
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

test("gateway search tools derive sources from result payloads", () => {
  assert.deepEqual(
    getAiSdkGatewaySearchToolResultMetadata({
      toolCallId: "call-web",
      toolName: "web_search",
      output: [
        {
          type: "web_search_result",
          url: "https://example.com/news",
          title: "Example News",
          pageAge: null,
          encryptedContent: "encrypted",
        },
      ],
    }),
    {
      callId: "call-web",
      toolName: "web_search",
      status: "success",
      sources: [
        {
          id: "web_search-call-web-0",
          url: "https://example.com/news",
          title: "Example News",
        },
      ],
      operation: "web_search",
      provider: "ai_gateway",
      retryable: false,
    }
  )

  assert.equal(
    getAiSdkGatewaySearchToolResultMetadata({
      toolCallId: "call-pplx",
      toolName: "perplexity_search",
      output: {
        id: "search-1",
        results: [
          {
            title: "Perplexity Result",
            url: "https://example.com/perplexity",
            snippet: "Snippet",
          },
        ],
      },
    }),
    null
  )

  assert.equal(
    getAiSdkGatewaySearchToolResultMetadata({
      toolCallId: "call-parallel",
      toolName: "parallel_search",
      output: {
        error: "timeout",
        message: "Timed out",
      },
    }),
    null
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
    openai: {
      reasoningEffort: "high",
      reasoningSummary: "detailed",
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
