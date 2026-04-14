import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsPath = path.join(cwd, "src/lib/shared/llm/models.ts")

test("shared model registry includes z-ai/glm-5.1 in all required sections", async () => {
  const source = await readFile(modelsPath, "utf8")

  assert.match(
    source,
    /OPENROUTER_Z_AI_GLM_5_1:\s*"z-ai\/glm-5\.1"/,
    "Expected AvailableModels to include OPENROUTER_Z_AI_GLM_5_1."
  )

  assert.match(
    source,
    /OPENROUTER_MODELS\s*=\s*\[[\s\S]*AvailableModels\.OPENROUTER_Z_AI_GLM_5_1[\s\S]*\]\s*as const/,
    "Expected OPENROUTER_MODELS to include OPENROUTER_Z_AI_GLM_5_1."
  )

  assert.match(
    source,
    /\[AvailableModels\.OPENROUTER_Z_AI_GLM_5_1\]:\s*\{[\s\S]*name:\s*"GLM 5\.1"/,
    "Expected ModelInfos to define display metadata for OPENROUTER_Z_AI_GLM_5_1."
  )
})
