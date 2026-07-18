import { ALL_MODELS, type ModelInfo, ModelInfos } from "@/lib/shared"

import { isE2eMockModeEnabled } from "../server/e2e-test-mode"
import { getOpenAiApiKey } from "../server/env"

/** Returns models for configured providers. */
export function getModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  if (getOpenAiApiKey() || isE2eMockModeEnabled()) {
    for (const modelId of ALL_MODELS) {
      models.push(ModelInfos[modelId])
    }
  }
  return models
}
