import {
  isModelSelectorModel,
  isModelType,
  type ModelInfo,
  type ModelType,
} from "@/lib/shared"

const STORED_SELECTED_MODEL_VERSION = 1

interface StoredSelectedModel {
  model: ModelType
  source: "user"
  version: typeof STORED_SELECTED_MODEL_VERSION
}

export function serializeStoredSelectedModel(
  model: ModelType
): StoredSelectedModel {
  return {
    model,
    source: "user",
    version: STORED_SELECTED_MODEL_VERSION,
  }
}

export function parseStoredSelectedModel(value: unknown): ModelType | null {
  if (typeof value !== "string") {
    return null
  }

  if (isModelType(value) && isModelSelectorModel(value)) {
    return value
  }

  try {
    const parsed: unknown = JSON.parse(value)

    if (
      parsed &&
      typeof parsed === "object" &&
      "model" in parsed &&
      "source" in parsed &&
      "version" in parsed &&
      parsed.source === "user" &&
      parsed.version === STORED_SELECTED_MODEL_VERSION &&
      isModelType(parsed.model) &&
      isModelSelectorModel(parsed.model)
    ) {
      return parsed.model
    }
  } catch {
    return null
  }

  return null
}

export function resolvePersistedSelectedModel(params: {
  storedModel: ModelType | null
  currentModel: ModelType | null
  initialSelectedModel: ModelType | null | undefined
  availableModels: ModelInfo[]
}): ModelType | null {
  const availableModelIds = new Set(
    params.availableModels
      .map((model) => model.id)
      .filter((modelId) => isModelSelectorModel(modelId))
  )
  const fallbackModel =
    params.initialSelectedModel &&
    availableModelIds.has(params.initialSelectedModel)
      ? params.initialSelectedModel
      : (params.availableModels.find((model) => availableModelIds.has(model.id))
          ?.id ?? null)

  if (params.storedModel && availableModelIds.has(params.storedModel)) {
    return params.storedModel
  }

  if (params.currentModel && availableModelIds.has(params.currentModel)) {
    return params.currentModel
  }

  return fallbackModel
}
