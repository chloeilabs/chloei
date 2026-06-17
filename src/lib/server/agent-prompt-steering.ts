export type PromptProvider = "zai"

interface PromptSteeringBlock {
  label: string
  body: string
}

interface CreatePromptSteeringBlocksParams {
  provider?: PromptProvider
  providerOverlaysEnabled?: boolean
}

const PROVIDER_OVERLAYS: Record<PromptProvider, string> = {
  zai: `
Use GLM reasoning mode efficiently.
- Take advantage of the long context window: skim and cite earlier turns before re-asking the user for information already present.
- Prefer direct execution and verification over speculative narration.
- On format-sensitive tasks, do a literal final-format check before finishing.
- Treat hard word, line, and sentence caps as hard caps. Count the final output when close to the limit.
- After tool use, synthesize the result and stop. Do not replay raw tool traces.
`.trim(),
}

export function resolvePromptProvider(): PromptProvider {
  return "zai"
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
