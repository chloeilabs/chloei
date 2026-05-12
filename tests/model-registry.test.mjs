import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsPath = path.join(cwd, "src/lib/shared/llm/models.ts")

test("shared model registry includes the curated gateway models", async () => {
  const source = await readFile(modelsPath, "utf8")

  assert.doesNotMatch(
    source,
    /qwen\/qwen3\.6-plus|z-ai\/glm-5\.1|Qwen3\.6 Plus|GLM 5\.1/,
    "Expected legacy model ids to be fully removed from the shared model registry."
  )

  assert.match(
    source,
    /OPENAI_GPT_5_5:\s*"openai\/gpt-5\.5"/,
    "Expected AvailableModels to include OPENAI_GPT_5_5."
  )

  assert.match(
    source,
    /MOONSHOTAI_KIMI_K2_6:\s*"moonshotai\/kimi-k2\.6"/,
    "Expected AvailableModels to include MOONSHOTAI_KIMI_K2_6."
  )

  assert.match(
    source,
    /DEEPSEEK_V4_PRO:\s*"deepseek\/deepseek-v4-pro"/,
    "Expected AvailableModels to include DEEPSEEK_V4_PRO."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /SUPPORTED_MODELS = \[ AvailableModels\.OPENAI_GPT_5_5, AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.DEEPSEEK_V4_PRO, \] as const/,
    "Expected SUPPORTED_MODELS to list only GPT-5.5, Kimi K2.6, and DeepSeek V4 Pro."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /MODEL_SELECTOR_MODELS = \[ AvailableModels\.OPENAI_GPT_5_5, AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.DEEPSEEK_V4_PRO, \] as const/,
    "Expected the chat model selector to expose GPT-5.5, Kimi K2.6, and DeepSeek V4 Pro, with GPT-5.5 first for attachment support."
  )

  assert.match(
    source,
    /\[AvailableModels\.OPENAI_GPT_5_5\]:\s*\{[\s\S]*name:\s*"GPT-5\.5"/,
    "Expected ModelInfos to define display metadata for OPENAI_GPT_5_5."
  )

  assert.match(
    source,
    /\[AvailableModels\.MOONSHOTAI_KIMI_K2_6\]:\s*\{[\s\S]*name:\s*"Kimi K2\.6"/,
    "Expected ModelInfos to define display metadata for MOONSHOTAI_KIMI_K2_6."
  )

  assert.match(
    source,
    /\[AvailableModels\.DEEPSEEK_V4_PRO\]:\s*\{[\s\S]*name:\s*"DeepSeek V4 Pro"/,
    "Expected ModelInfos to define display metadata for DEEPSEEK_V4_PRO."
  )

  for (const modelKey of ["MOONSHOTAI_KIMI_K2_6", "OPENAI_GPT_5_5"]) {
    assert.match(
      source,
      new RegExp(
        `VISION_CAPABLE_MODEL_SET[\\s\\S]*AvailableModels\\.${modelKey}`
      ),
      `Expected ${modelKey} to be treated as image-capable based on current Gateway endpoint modalities.`
    )
  }

  assert.doesNotMatch(
    source.match(/VISION_CAPABLE_MODEL_SET[\s\S]*?\]\)/)?.[0] ?? "",
    /AvailableModels\.DEEPSEEK_V4_PRO/,
    "Expected DeepSeek V4 Pro to use image preprocessing because Gateway does not mark it as a vision model."
  )

  assert.match(
    source,
    /FILE_INPUT_CAPABLE_MODEL_SET[\s\S]*AvailableModels\.OPENAI_GPT_5_5/,
    "Expected GPT-5.5 to receive native PDF file parts."
  )

  assert.doesNotMatch(
    source.match(/FILE_INPUT_CAPABLE_MODEL_SET[\s\S]*?\]\)/)?.[0] ?? "",
    /AvailableModels\.(DEEPSEEK_V4_PRO|MOONSHOTAI_KIMI_K2_6)/,
    "Expected DeepSeek V4 Pro and Kimi K2.6 to use PDF text preprocessing instead of native file parts."
  )
})
