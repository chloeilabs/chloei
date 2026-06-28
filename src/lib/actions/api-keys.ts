import {
  ALL_MODELS,
  AvailableModels,
  type ModelInfo,
  ModelInfos,
} from "@/lib/shared"

import { isE2eMockModeEnabled } from "../server/e2e-test-mode"
import { getOpenAiApiKey } from "../server/env"

/** Returns models for configured providers. */
export function getModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  if (getOpenAiApiKey() || isE2eMockModeEnabled()) {
    for (const modelId of ALL_MODELS) {
      models.push(ModelInfos[modelId])
    }
    // "Goblins" is a virtual multi-agent mode (GPT-5.5 manager + gpt-5.4-mini
    // sub-agents), so it is offered whenever OpenAI is configured but is not part
    // of ALL_MODELS (the real, individually callable models).
    models.push(ModelInfos[AvailableModels.OPENAI_GOBLINS])
  }
  return models
}
