export const AvailableModels = {
  OPENROUTER_ANTHROPIC_CLAUDE_OPUS_4_6_FAST:
    "anthropic/claude-opus-4.6-fast",
  OPENROUTER_QWEN_QWEN3_6_PLUS: "qwen/qwen3.6-plus",
  OPENROUTER_MINIMAX_M2_7: "minimax/minimax-m2.7",
  OPENROUTER_Z_AI_GLM_5_1: "z-ai/glm-5.1",
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

export const OPENROUTER_MODELS = [
  AvailableModels.OPENROUTER_QWEN_QWEN3_6_PLUS,
  AvailableModels.OPENROUTER_MINIMAX_M2_7,
  AvailableModels.OPENROUTER_Z_AI_GLM_5_1,
  AvailableModels.OPENROUTER_ANTHROPIC_CLAUDE_OPUS_4_6_FAST,
] as const

export const ALL_MODELS = [...OPENROUTER_MODELS] as const

export function resolveDefaultModel(
  models: readonly Pick<ModelInfo, "id">[]
): ModelType {
  return models[0]?.id ?? OPENROUTER_MODELS[0]
}

export const ModelInfos: Record<ModelType, ModelInfo> = {
  [AvailableModels.OPENROUTER_ANTHROPIC_CLAUDE_OPUS_4_6_FAST]: {
    id: AvailableModels.OPENROUTER_ANTHROPIC_CLAUDE_OPUS_4_6_FAST,
    name: "Claude Opus 4.6 Fast",
  },
  [AvailableModels.OPENROUTER_QWEN_QWEN3_6_PLUS]: {
    id: AvailableModels.OPENROUTER_QWEN_QWEN3_6_PLUS,
    name: "Qwen3.6 Plus",
  },
  [AvailableModels.OPENROUTER_MINIMAX_M2_7]: {
    id: AvailableModels.OPENROUTER_MINIMAX_M2_7,
    name: "MiniMax M2.7",
  },
  [AvailableModels.OPENROUTER_Z_AI_GLM_5_1]: {
    id: AvailableModels.OPENROUTER_Z_AI_GLM_5_1,
    name: "GLM 5.1",
  },
}
