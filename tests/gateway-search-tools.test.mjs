import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const tavilyToolsPath = path.join(
  cwd,
  "src/lib/server/llm/ai-sdk-tavily-tools.ts"
)
const persistentSelectedModelUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-selected-model-utils.ts")
).href

const {
  parseStoredSelectedModel,
  resolvePersistedSelectedModel,
  serializeStoredSelectedModel,
} = await import(persistentSelectedModelUrl)

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

test("stale and fallback-only model ids fall back to GLM 5.2", () => {
  assert.equal(parseStoredSelectedModel("qwen/qwen3.6-plus"), null)
  assert.equal(
    parseStoredSelectedModel(
      JSON.stringify(serializeStoredSelectedModel("openai/gpt-5.5"))
    ),
    null
  )

  assert.equal(
    resolvePersistedSelectedModel({
      storedModel: null,
      currentModel: null,
      initialSelectedModel: null,
      availableModels: [
        {
          id: "zai/glm-5.2",
          name: "GLM 5.2",
        },
      ],
    }),
    "zai/glm-5.2"
  )
})
