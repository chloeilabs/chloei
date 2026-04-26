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
    /ANTHROPIC_CLAUDE_SONNET_4_6:\s*"anthropic\/claude-sonnet-4\.6"/,
    "Expected AvailableModels to include ANTHROPIC_CLAUDE_SONNET_4_6."
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
    /SUPPORTED_MODELS = \[ AvailableModels\.OPENAI_GPT_5_5, AvailableModels\.ANTHROPIC_CLAUDE_SONNET_4_6, AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.DEEPSEEK_V4_PRO, \] as const/,
    "Expected SUPPORTED_MODELS to list OPENAI_GPT_5_5 first (default), followed by the curated gateway models."
  )

  assert.match(
    source.replace(/\s+/g, " "),
    /MODEL_SELECTOR_MODELS = \[ AvailableModels\.MOONSHOTAI_KIMI_K2_6, AvailableModels\.DEEPSEEK_V4_PRO, \] as const/,
    "Expected the chat model selector to only expose Kimi K2.6 and DeepSeek V4 Pro."
  )

  assert.match(
    source,
    /\[AvailableModels\.ANTHROPIC_CLAUDE_SONNET_4_6\]:\s*\{[\s\S]*name:\s*"Claude Sonnet 4\.6"/,
    "Expected ModelInfos to define display metadata for ANTHROPIC_CLAUDE_SONNET_4_6."
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
})
