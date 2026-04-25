import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const modelsPath = path.join(cwd, "src/lib/shared/llm/models.ts")

test("shared model registry includes the curated Anthropic and OpenAI models", async () => {
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
    source.replace(/\s+/g, " "),
    /SUPPORTED_MODELS = \[ AvailableModels\.OPENAI_GPT_5_5, AvailableModels\.ANTHROPIC_CLAUDE_SONNET_4_6, \] as const/,
    "Expected SUPPORTED_MODELS to list OPENAI_GPT_5_5 first (default) followed by ANTHROPIC_CLAUDE_SONNET_4_6."
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
})
