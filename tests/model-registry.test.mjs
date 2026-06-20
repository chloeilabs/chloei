import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsPath = path.join(cwd, "src/lib/shared/llm/models.ts")

test("shared model registry exposes GLM 5.2 as the only model", async () => {
  const source = await readFile(modelsPath, "utf8")

  assert.doesNotMatch(
    source,
    /qwen\/qwen3\.6-plus|z-ai\/glm-5\.1|deepseek\/deepseek-v4-pro|openai\/gpt-5\.5|google\/gemini-3\.1-pro-preview|xiaomi\/mimo-v2\.5-pro/,
    "Expected legacy model ids to be fully removed from the shared model registry."
  )

  assert.doesNotMatch(
    source,
    /alibaba\/qwen3\.7-max|moonshotai\/kimi-k2\.6|ALIBABA_QWEN3_7_MAX|MOONSHOTAI_KIMI_K2_6|Qwen 3\.7 Max|Kimi K2\.6/,
    "Expected Qwen 3.7 Max and Kimi K2.6 to be removed so GLM 5.2 is the only model."
  )

  assert.match(
    source,
    /ZAI_GLM_5_2:\s*"zai\/glm-5\.2"/,
    "Expected AvailableModels to include ZAI_GLM_5_2."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /SUPPORTED_MODELS = \[AvailableModels\.ZAI_GLM_5_2\] as const/,
    "Expected SUPPORTED_MODELS to list GLM 5.2 only."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /MODEL_SELECTOR_MODELS = \[AvailableModels\.ZAI_GLM_5_2\] as const/,
    "Expected MODEL_SELECTOR_MODELS to list GLM 5.2 only."
  )

  assert.match(
    source,
    /\[AvailableModels\.ZAI_GLM_5_2\]:\s*\{[\s\S]*name:\s*"GLM 5\.2"/,
    "Expected ModelInfos to define display metadata for ZAI_GLM_5_2."
  )
})
