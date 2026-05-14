import { ALL_MODELS, type ModelInfo, ModelInfos } from "@/lib/shared"

import { isAiGatewayAuthConfigured } from "../server/ai-gateway-auth"

/** Returns models for configured providers. */
export function getModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  if (isAiGatewayAuthConfigured()) {
    for (const modelId of ALL_MODELS) {
      models.push(ModelInfos[modelId])
    }
  }
  return models
}
