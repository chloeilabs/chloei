import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsPath = path.join(cwd, "src/lib/shared/llm/models.ts")

test("shared model registry exposes GPT-5.5 (default) and GPT-5.4 Mini", async () => {
  const source = await readFile(modelsPath, "utf8")

  assert.doesNotMatch(
    source,
    /qwen\/qwen3\.6-plus|z-ai\/glm-5\.1|deepseek\/deepseek-v4-pro|google\/gemini-3\.1-pro-preview|xiaomi\/mimo-v2\.5-pro/,
    "Expected legacy model ids to be fully removed from the shared model registry."
  )

  assert.doesNotMatch(
    source,
    /anthropic\/claude-opus-4\.8|ANTHROPIC_CLAUDE_OPUS_4_8|Claude Opus 4\.8|zai\/glm-5\.2|GLM 5\.2/,
    "Expected prior models (Claude Opus 4.8, GLM 5.2) to be removed."
  )

  assert.match(
    source,
    /OPENAI_GPT_5_5:\s*"gpt-5\.5-2026-04-23"/,
    "Expected AvailableModels to include OPENAI_GPT_5_5."
  )
  assert.match(
    source,
    /OPENAI_GPT_5_4_MINI:\s*"gpt-5\.4-mini"/,
    "Expected AvailableModels to include OPENAI_GPT_5_4_MINI."
  )

  // GPT-5.5 must be listed FIRST so it is the default selected model.
  assert.match(
    source,
    /SUPPORTED_MODELS = \[\s*AvailableModels\.OPENAI_GPT_5_5,\s*AvailableModels\.OPENAI_GPT_5_4_MINI,?\s*\] as const/,
    "Expected SUPPORTED_MODELS to list GPT-5.5 first, then GPT-5.4 Mini."
  )

  assert.match(
    source,
    /MODEL_SELECTOR_MODELS = \[\s*AvailableModels\.OPENAI_GPT_5_5,\s*AvailableModels\.OPENAI_GPT_5_4_MINI,?\s*\] as const/,
    "Expected MODEL_SELECTOR_MODELS to list GPT-5.5 first (default), then GPT-5.4 Mini."
  )

  assert.match(
    source,
    /\[AvailableModels\.OPENAI_GPT_5_5\]:\s*\{[\s\S]*name:\s*"GPT-5\.5"/,
    "Expected ModelInfos to define display metadata for OPENAI_GPT_5_5."
  )
})
