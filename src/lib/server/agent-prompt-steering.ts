import { AvailableModels, type ModelType } from "@/lib/shared"

export type PromptProvider =
  | "alibaba"
  | "anthropic"
  | "moonshotai"
  | "openai"
  | "zai"

interface PromptSteeringBlock {
  label: string
  body: string
}

interface CreatePromptSteeringBlocksParams {
  provider?: PromptProvider
  providerOverlaysEnabled?: boolean
}

const PROVIDER_OVERLAYS: Record<PromptProvider, string> = {
  openai: `
Use GPT-5 reasoning efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  anthropic: `
Use Claude's extended thinking efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  alibaba: `
Use Qwen reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  moonshotai: `
Use Kimi reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
  zai: `
Use GLM reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
}

export function resolvePromptProvider(model: ModelType): PromptProvider {
  // Goblins mode is orchestrated by GPT-5.5 (an OpenAI model), so it uses the
  // OpenAI overlay even though "goblins" is not a real model id.
  if (model === AvailableModels.OPENAI_GOBLINS || model.startsWith("gpt-")) {
    return "openai"
  }

  if (model.startsWith("anthropic/")) {
    return "anthropic"
  }

  if (model.startsWith("alibaba/")) {
    return "alibaba"
  }

  if (model.startsWith("moonshotai/")) {
    return "moonshotai"
  }

  if (model.startsWith("zai/")) {
    return "zai"
  }

  throw new Error(`Unsupported model provider for model: ${model}`)
}

export function createPromptSteeringBlocks(
  params: CreatePromptSteeringBlocksParams
): PromptSteeringBlock[] {
  const blocks: PromptSteeringBlock[] = []

  if (params.provider && params.providerOverlaysEnabled !== false) {
    blocks.push({
      label: `PROVIDER OVERLAY: ${params.provider.toUpperCase()}`,
      body: PROVIDER_OVERLAYS[params.provider],
    })
  }

  return blocks
}
