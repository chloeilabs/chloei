export const AvailableModels = {
  OPENAI_GPT_5_5: "gpt-5.5-2026-04-23",
  OPENAI_GPT_5_4_MINI: "gpt-5.4-mini",
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

// Order matters: the first entry is the default selected model (see
// resolveDefaultModelSelectorModel).
export const SUPPORTED_MODELS = [
  AvailableModels.OPENAI_GPT_5_5,
  AvailableModels.OPENAI_GPT_5_4_MINI,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export const MODEL_SELECTOR_MODELS = [
  AvailableModels.OPENAI_GPT_5_5,
  AvailableModels.OPENAI_GPT_5_4_MINI,
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
  const modelById = new Map(models.map((model) => [model.id, model]))
  return MODEL_SELECTOR_MODELS.flatMap((modelId) => {
    const model = modelById.get(modelId)
    return model ? [model] : []
  })
}

export function resolveDefaultModelSelectorModel(
  models: readonly Pick<ModelInfo, "id">[]
): ModelType {
  return models[0]?.id ?? MODEL_SELECTOR_MODELS[0]
}

export const ModelInfos: Record<ModelType, ModelInfo> = {
  [AvailableModels.OPENAI_GPT_5_5]: {
    id: AvailableModels.OPENAI_GPT_5_5,
    name: "GPT-5.5",
  },
  [AvailableModels.OPENAI_GPT_5_4_MINI]: {
    id: AvailableModels.OPENAI_GPT_5_4_MINI,
    name: "GPT-5.4 Mini",
  },
}
