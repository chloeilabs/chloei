export const AvailableModels = {
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

export const SUPPORTED_MODELS = [AvailableModels.ZAI_GLM_5_2] as const

export const ALL_MODELS = [...SUPPORTED_MODELS] as const

/** The single model the app runs on. */
export const DEFAULT_MODEL: ModelType = AvailableModels.ZAI_GLM_5_2

export const ModelInfos: Record<ModelType, ModelInfo> = {
  [AvailableModels.ZAI_GLM_5_2]: {
    id: AvailableModels.ZAI_GLM_5_2,
    name: "GLM 5.2",
  },
}
