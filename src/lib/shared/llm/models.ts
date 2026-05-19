export const AvailableModels = {
  GOOGLE_GEMINI_3_1_PRO_PREVIEW: "google/gemini-3.1-pro-preview",
  GOOGLE_GEMINI_3_5_FLASH: "google/gemini-3.5-flash",
  MOONSHOTAI_KIMI_K2_6: "moonshotai/kimi-k2.6",
  XIAOMI_MIMO_V2_5_PRO: "xiaomi/mimo-v2.5-pro",
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
  AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW,
  AvailableModels.GOOGLE_GEMINI_3_5_FLASH,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.XIAOMI_MIMO_V2_5_PRO,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export const RESEARCH_MODEL = AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW

export const MODEL_SELECTOR_MODELS = [
  AvailableModels.GOOGLE_GEMINI_3_5_FLASH,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.XIAOMI_MIMO_V2_5_PRO,
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
  [AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW]: {
    id: AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW,
    name: "Gemini 3.1 Pro Preview",
  },
  [AvailableModels.GOOGLE_GEMINI_3_5_FLASH]: {
    id: AvailableModels.GOOGLE_GEMINI_3_5_FLASH,
    name: "Gemini 3.5 Flash",
  },
  [AvailableModels.MOONSHOTAI_KIMI_K2_6]: {
    id: AvailableModels.MOONSHOTAI_KIMI_K2_6,
    name: "Kimi K2.6",
  },
  [AvailableModels.XIAOMI_MIMO_V2_5_PRO]: {
    id: AvailableModels.XIAOMI_MIMO_V2_5_PRO,
    name: "MiMo V2.5 Pro",
  },
}

const VISION_CAPABLE_MODEL_SET: ReadonlySet<ModelType> = new Set([
  AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW,
  AvailableModels.GOOGLE_GEMINI_3_5_FLASH,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.XIAOMI_MIMO_V2_5_PRO,
])

export function modelSupportsImageInput(model: ModelType): boolean {
  return VISION_CAPABLE_MODEL_SET.has(model)
}

const FILE_INPUT_CAPABLE_MODEL_SET: ReadonlySet<ModelType> = new Set([
  AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW,
  AvailableModels.GOOGLE_GEMINI_3_5_FLASH,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.XIAOMI_MIMO_V2_5_PRO,
])

export function modelSupportsFileInput(model: ModelType): boolean {
  return FILE_INPUT_CAPABLE_MODEL_SET.has(model)
}

export const VISION_PREPROCESSOR_MODEL: ModelType =
  AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW

export const PDF_PREPROCESSOR_MODEL: ModelType =
  AvailableModels.GOOGLE_GEMINI_3_1_PRO_PREVIEW
