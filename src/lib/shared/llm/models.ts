export const AvailableModels = {
  ALIBABA_QWEN3_7_MAX: "alibaba/qwen3.7-max",
  MOONSHOTAI_KIMI_K2_6: "moonshotai/kimi-k2.6",
  ZAI_GLM_5_2: "zai/glm-5.2",
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
  AvailableModels.ALIBABA_QWEN3_7_MAX,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.ZAI_GLM_5_2,
] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

export const MODEL_SELECTOR_MODELS = [
  AvailableModels.ALIBABA_QWEN3_7_MAX,
  AvailableModels.MOONSHOTAI_KIMI_K2_6,
  AvailableModels.ZAI_GLM_5_2,
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
  [AvailableModels.ALIBABA_QWEN3_7_MAX]: {
    id: AvailableModels.ALIBABA_QWEN3_7_MAX,
    name: "Qwen 3.7 Max",
  },
  [AvailableModels.MOONSHOTAI_KIMI_K2_6]: {
    id: AvailableModels.MOONSHOTAI_KIMI_K2_6,
    name: "Kimi K2.6",
  },
  [AvailableModels.ZAI_GLM_5_2]: {
    id: AvailableModels.ZAI_GLM_5_2,
    name: "GLM 5.2",
  },
}
