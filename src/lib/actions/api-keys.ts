import { ALL_MODELS, type ModelInfo, ModelInfos } from "@/lib/shared"

/** Returns models for configured providers. */
export function getModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  if (process.env.AI_GATEWAY_API_KEY) {
    for (const modelId of ALL_MODELS) {
      models.push(ModelInfos[modelId])
    }
  }
  return models
}
