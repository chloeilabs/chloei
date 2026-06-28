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

  // GPT-5.5 stays first (default); "goblins" is appended as the last selector
  // entry (the virtual multi-agent mode).
  assert.match(
    source,
    /MODEL_SELECTOR_MODELS = \[\s*AvailableModels\.OPENAI_GPT_5_5,\s*AvailableModels\.OPENAI_GPT_5_4_MINI,\s*AvailableModels\.OPENAI_GOBLINS,?\s*\] as const/,
    "Expected MODEL_SELECTOR_MODELS to list GPT-5.5, GPT-5.4 Mini, then Goblins."
  )

  assert.match(
    source,
    /\[AvailableModels\.OPENAI_GPT_5_5\]:\s*\{[\s\S]*name:\s*"GPT-5\.5"/,
    "Expected ModelInfos to define display metadata for OPENAI_GPT_5_5."
  )

  // "goblins" is a virtual selectable mode: present in AvailableModels +
  // ModelInfos, but NOT in SUPPORTED_MODELS / ALL_MODELS (the real models).
  assert.match(
    source,
    /OPENAI_GOBLINS:\s*"goblins"/,
    "Expected AvailableModels to include the virtual OPENAI_GOBLINS id."
  )
  assert.match(
    source,
    /\[AvailableModels\.OPENAI_GOBLINS\]:\s*\{[\s\S]*name:\s*"Goblins"/,
    "Expected ModelInfos to define display metadata for OPENAI_GOBLINS."
  )
  // [^\]]* stays within the SUPPORTED_MODELS array (up to its closing bracket),
  // so this asserts Goblins is not one of the real callable models.
  assert.doesNotMatch(
    source,
    /SUPPORTED_MODELS = \[[^\]]*OPENAI_GOBLINS/,
    "Expected Goblins to be excluded from SUPPORTED_MODELS (it is a mode, not a real model)."
  )
})
