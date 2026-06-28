export const AvailableModels = {
  OPENAI_GPT_5_5: "gpt-5.5-2026-04-23",
  OPENAI_GPT_5_4_MINI: "gpt-5.4-mini",
  // "Goblins" is a virtual multi-agent MODE, not a real OpenAI model id. It is a
  // selectable ModelType so it flows through the existing model plumbing, but it
  // is deliberately kept OUT of SUPPORTED_MODELS / ALL_MODELS (the real callable
  // models). The runtime branches on it before any real model id reaches the
  // Agents SDK: a GPT-5.5 manager orchestrates up to 6 gpt-5.4-mini sub-agents.
  OPENAI_GOBLINS: "goblins",
} as const

export type ModelType = (typeof AvailableModels)[keyof typeof AvailableModels]

// The real model GPT-5.5 acts as the Goblins manager + final synthesizer.
export const GOBLINS_MANAGER_MODEL = AvailableModels.OPENAI_GPT_5_5

export function isGoblinsModel(value: unknown): value is "goblins" {
  return value === AvailableModels.OPENAI_GOBLINS
}

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

// Real, individually callable models only. "goblins" is intentionally excluded
// — it is a mode, not a model the SDK can run.
export const ALL_MODELS = [...SUPPORTED_MODELS] as const

// Selector entries (what the home-page dropdown offers). GPT-5.5 stays first so
// the resolved default is unchanged; "goblins" is appended as the last option.
export const MODEL_SELECTOR_MODELS = [
  AvailableModels.OPENAI_GPT_5_5,
  AvailableModels.OPENAI_GPT_5_4_MINI,
  AvailableModels.OPENAI_GOBLINS,
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
  [AvailableModels.OPENAI_GOBLINS]: {
    id: AvailableModels.OPENAI_GOBLINS,
    name: "Goblins",
  },
}
