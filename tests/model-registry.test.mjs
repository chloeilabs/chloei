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
    /qwen\/qwen3\.6-plus|z-ai\/glm-5\.1|deepseek\/deepseek-v4-pro|openai\/gpt-5\.5|Qwen3\.6 Plus|GLM 5\.1|DEEPSEEK_V4_PRO|OPENAI_GPT_5_5|DeepSeek V4 Pro|GPT-5\.5/,
    "Expected legacy model ids to be fully removed from the shared model registry."
  )

  assert.match(
    source,
    /ALIBABA_QWEN3_7_MAX:\s*"alibaba\/qwen3\.7-max"/,
    "Expected AvailableModels to include ALIBABA_QWEN3_7_MAX."
  )

  assert.match(
    source,
    /GOOGLE_GEMINI_3_1_PRO_PREVIEW:\s*"google\/gemini-3\.1-pro-preview"/,
    "Expected AvailableModels to include GOOGLE_GEMINI_3_1_PRO_PREVIEW."
  )

  assert.match(
    source,
    /MOONSHOTAI_KIMI_K2_6:\s*"moonshotai\/kimi-k2\.6"/,
    "Expected AvailableModels to include MOONSHOTAI_KIMI_K2_6."
  )

  assert.match(
    source,
    /XIAOMI_MIMO_V2_5_PRO:\s*"xiaomi\/mimo-v2\.5-pro"/,
    "Expected AvailableModels to include XIAOMI_MIMO_V2_5_PRO."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /SUPPORTED_MODELS = \[ AvailableModels\.ALIBABA_QWEN3_7_MAX, AvailableModels\.GOOGLE_GEMINI_3_1_PRO_PREVIEW, AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.XIAOMI_MIMO_V2_5_PRO, \] as const/,
    "Expected SUPPORTED_MODELS to list Qwen 3.7 Max, Gemini 3.1 Pro Preview, Kimi K2.6, and MiMo V2.5 Pro."
  )

  assert.match(
    source,
    /RESEARCH_MODEL = AvailableModels\.ALIBABA_QWEN3_7_MAX/,
    "Expected Research mode to use Qwen 3.7 Max."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /MODEL_SELECTOR_MODELS = \[ AvailableModels\.ALIBABA_QWEN3_7_MAX, AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.XIAOMI_MIMO_V2_5_PRO, \] as const/,
    "Expected the chat model selector to default to Qwen 3.7 Max before Kimi K2.6 and MiMo V2.5 Pro."
  )

  assert.match(
    source,
    /\[AvailableModels\.ALIBABA_QWEN3_7_MAX\]:\s*\{[\s\S]*name:\s*"Qwen 3\.7 Max"/,
    "Expected ModelInfos to define display metadata for ALIBABA_QWEN3_7_MAX."
  )

  assert.match(
    source,
    /\[AvailableModels\.GOOGLE_GEMINI_3_1_PRO_PREVIEW\]:\s*\{[\s\S]*name:\s*"Gemini 3\.1 Pro Preview"/,
    "Expected ModelInfos to define display metadata for GOOGLE_GEMINI_3_1_PRO_PREVIEW."
  )

  assert.match(
    source,
    /\[AvailableModels\.MOONSHOTAI_KIMI_K2_6\]:\s*\{[\s\S]*name:\s*"Kimi K2\.6"/,
    "Expected ModelInfos to define display metadata for MOONSHOTAI_KIMI_K2_6."
  )

  assert.match(
    source,
    /\[AvailableModels\.XIAOMI_MIMO_V2_5_PRO\]:\s*\{[\s\S]*name:\s*"MiMo V2\.5 Pro"/,
    "Expected ModelInfos to define display metadata for XIAOMI_MIMO_V2_5_PRO."
  )
})
