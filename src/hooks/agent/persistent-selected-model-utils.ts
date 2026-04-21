import { isModelType, type ModelInfo, type ModelType } from "@/lib/shared"

export function parseStoredSelectedModel(value: unknown): ModelType | null {
  return isModelType(value) ? value : null
}

export function resolvePersistedSelectedModel(params: {
  storedModel: ModelType | null
  currentModel: ModelType | null
  initialSelectedModel: ModelType | null | undefined
  availableModels: ModelInfo[]
}): ModelType | null {
  const availableModelIds = new Set(
    params.availableModels.map((model) => model.id)
  )
  const fallbackModel =
    params.initialSelectedModel &&
    availableModelIds.has(params.initialSelectedModel)
      ? params.initialSelectedModel
      : (params.availableModels[0]?.id ?? null)

  if (params.storedModel && availableModelIds.has(params.storedModel)) {
    return params.storedModel
  }

  if (params.currentModel && availableModelIds.has(params.currentModel)) {
    return params.currentModel
  }

  return fallbackModel
}
