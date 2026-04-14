import { type ModelInfo, ModelInfos, OPENROUTER_MODELS } from "@/lib/shared"

/** Returns models for configured providers. */
export function getModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  if (process.env.OPENROUTER_API_KEY) {
    for (const modelId of OPENROUTER_MODELS) {
      models.push(ModelInfos[modelId])
    }
  }
  return models
}
