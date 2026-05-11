export const AvailableModels = {
  DEEPSEEK_V4_PRO: "deepseek/deepseek-v4-pro",
  MOONSHOTAI_KIMI_K2_6: "moonshotai/kimi-k2.6",
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
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.DEEPSEEK_V4_PRO,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export const MODEL_SELECTOR_MODELS = [
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.DEEPSEEK_V4_PRO,
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
}

const VISION_CAPABLE_MODEL_SET: ReadonlySet<ModelType> = new Set([
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.OPENAI_GPT_5_5,
])

export function modelSupportsImageInput(model: ModelType): boolean {
  return VISION_CAPABLE_MODEL_SET.has(model)
}

const FILE_INPUT_CAPABLE_MODEL_SET: ReadonlySet<ModelType> = new Set([
  // Kimi currently rejects AI SDK file parts through Gateway despite its metadata.
  AvailableModels.OPENAI_GPT_5_5,
])

export function modelSupportsFileInput(model: ModelType): boolean {
  return FILE_INPUT_CAPABLE_MODEL_SET.has(model)
}

export const VISION_PREPROCESSOR_MODEL: ModelType =
  AvailableModels.OPENAI_GPT_5_5

export const PDF_PREPROCESSOR_MODEL: ModelType = AvailableModels.OPENAI_GPT_5_5
