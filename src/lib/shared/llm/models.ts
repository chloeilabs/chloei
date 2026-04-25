export const AvailableModels = {
  ANTHROPIC_CLAUDE_SONNET_4_6: "anthropic/claude-sonnet-4.6",
  OPENAI_GPT_5_5: "openai/gpt-5.5",
} as const

export type ModelType = (typeof AvailableModels)[keyof typeof AvailableModels]

export function isModelType(value: unknown): value is ModelType {
  return (
    typeof value === "string" &&
    Object.values(AvailableModels).includes(value as ModelType)
  )
}

export interface ModelInfo {
  id: ModelType
  name: string
}

export const SUPPORTED_MODELS = [
  AvailableModels.OPENAI_GPT_5_5,
  AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export function resolveDefaultModel(
  models: readonly Pick<ModelInfo, "id">[]
): ModelType {
  return models[0]?.id ?? SUPPORTED_MODELS[0]
}

export const ModelInfos: Record<ModelType, ModelInfo> = {
  [AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6]: {
    id: AvailableModels.ANTHROPIC_CLAUDE_SONNET_4_6,
    name: "Claude Sonnet 4.6",
  },
  [AvailableModels.OPENAI_GPT_5_5]: {
    id: AvailableModels.OPENAI_GPT_5_5,
    name: "GPT-5.5",
  },
}
