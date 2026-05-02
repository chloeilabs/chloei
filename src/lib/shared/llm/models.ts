export const AvailableModels = {
  ANTHROPIC_CLAUDE_SONNET_4_6: "anthropic/claude-sonnet-4.6",
  DEEPSEEK_V4_PRO: "deepseek/deepseek-v4-pro",
  MOONSHOTAI_KIMI_K2_6: "moonshotai/kimi-k2.6",
  OPENAI_GPT_5_5: "openai/gpt-5.5",
  XAI_GROK_4_3: "xai/grok-4.3",
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
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.DEEPSEEK_V4_PRO,
  AvailableModels.XAI_GROK_4_3,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export const MODEL_SELECTOR_MODELS = [
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.DEEPSEEK_V4_PRO,
  AvailableModels.XAI_GROK_4_3,
] as const

const MODEL_SELECTOR_MODEL_SET: ReadonlySet<ModelType> = new Set(
  MODEL_SELECTOR_MODELS
)

export function isModelSelectorModel(value: unknown): value is ModelType {
  return (
    typeof value === "string" &&
    MODEL_SELECTOR_MODEL_SET.has(value as ModelType)
  )
}

export function getModelSelectorModels(
  models: readonly ModelInfo[]
): ModelInfo[] {
  return models.filter((model) => isModelSelectorModel(model.id))
}

export function resolveDefaultModelSelectorModel(
  models: readonly Pick<ModelInfo, "id">[]
): ModelType {
  return models[0]?.id ?? MODEL_SELECTOR_MODELS[0]
}

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
  [AvailableModels.DEEPSEEK_V4_PRO]: {
    id: AvailableModels.DEEPSEEK_V4_PRO,
    name: "DeepSeek V4 Pro",
  },
  [AvailableModels.MOONSHOTAI_KIMI_K2_6]: {
    id: AvailableModels.MOONSHOTAI_KIMI_K2_6,
    name: "Kimi K2.6",
  },
  [AvailableModels.OPENAI_GPT_5_5]: {
    id: AvailableModels.OPENAI_GPT_5_5,
    name: "GPT-5.5",
  },
  [AvailableModels.XAI_GROK_4_3]: {
    id: AvailableModels.XAI_GROK_4_3,
    name: "Grok 4.3",
  },
}
