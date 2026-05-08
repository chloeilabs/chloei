import { createGateway } from "@ai-sdk/gateway"
import { embed, embedMany } from "ai"

import { aiGatewayFetch } from "@/lib/server/llm/gateway-client"

const EMBEDDING_MODEL_ID = "openai/text-embedding-3-small"
export const MEMORY_EMBEDDING_DIMENSIONS = 1536

interface EmbedParams {
  aiGatewayApiKey: string
  signal?: AbortSignal
}

export async function embedMemoryText(
  text: string,
  params: EmbedParams
): Promise<number[]> {
  const gateway = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })
  const { embedding } = await embed({
    model: gateway.embeddingModel(EMBEDDING_MODEL_ID),
    value: text,
    abortSignal: params.signal,
  })
  return embedding
}

export async function embedMemoryTexts(
  texts: readonly string[],
  params: EmbedParams
): Promise<number[][]> {
  if (texts.length === 0) {
    return []
  }
  const gateway = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })
  const { embeddings } = await embedMany({
    model: gateway.embeddingModel(EMBEDDING_MODEL_ID),
    values: [...texts],
    abortSignal: params.signal,
  })
  return embeddings
}
