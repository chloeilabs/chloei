import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const exaToolsPath = path.join(
  cwd,
  "src/lib/server/llm/openai-agents-exa-tools.ts"
)
const persistentSelectedModelUrl = pathToFileURL(
  path.join(cwd, "src/hooks/agent/persistent-selected-model-utils.ts")
).href

const {
  parseStoredSelectedModel,
  resolvePersistedSelectedModel,
  serializeStoredSelectedModel,
} = await import(persistentSelectedModelUrl)

test("exa search tool results derive source links", async () => {
  const source = await readFile(exaToolsPath, "utf8")

  assert.match(
    source,
    /sources: payload\.output[\s\S]*toSourcesFromOutput\(toolName, payload\.output\)/,
    "Expected Exa tool results to expose source links from successful search output."
  )
  assert.match(
    source,
    /id: `\$\{toolName\}-\$\{requestId\}-\$\{String\(index\)\}`/,
    "Expected Exa source ids to be stable per tool call and result index."
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

test("stale and fallback-only model ids fall back to GPT-5.4 Mini", () => {
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
          id: "gpt-5.4-mini",
          name: "GPT-5.4 Mini",
        },
      ],
    }),
    "gpt-5.4-mini"
  )
})

test("exa tools dedupe repeat fetches through the shared research state", async () => {
  const source = await readFile(exaToolsPath, "utf8")

  assert.match(
    source,
    /export function createSharedResearchState\(\)/,
    "Expected the shared research state factory to be exported for Goblins mode."
  )
  assert.match(
    source,
    /shared\.seenUrls\.has\(result\.url\)[\s\S]*SHARED_DUPLICATE_CONTENT_NOTE/,
    "Expected repeat search hits to be annotated instead of repeating content."
  )
  assert.match(
    source,
    /shared\.contentByUrl\.get\(url\)/,
    "Expected exa_get_contents to serve cache hits from the shared state."
  )
  assert.match(
    source,
    /urlsToFetch\.length > 0/,
    "Expected all-cached get_contents batches to skip the Exa network call."
  )
  assert.match(
    source,
    /GOBLINS_SHARED_CONTENT_CACHE_MAX_ENTRIES/,
    "Expected the shared content cache to be bounded."
  )
})
