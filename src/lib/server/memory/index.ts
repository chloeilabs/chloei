import { createLogger } from "@/lib/logger"

import {
  AGENT_MEMORY_DEDUP_THRESHOLD,
  AGENT_MEMORY_ENABLED,
  AGENT_MEMORY_MAX_FACTS_PER_TURN,
  AGENT_MEMORY_SEARCH_THRESHOLD,
  AGENT_MEMORY_SEARCH_TOP_K,
} from "./config"
import { embedMemoryText, embedMemoryTexts } from "./embeddings"
import { extractMemoryFacts } from "./extractor"
import {
  insertMemory,
  isMemoryStoreNotInitializedError,
  searchMemoriesByVector,
} from "./store"
import type { MemoryRecord } from "./types"

const logger = createLogger("agent-memory")

export { formatMemoryBlock } from "./format"
export { isMemoryStoreNotInitializedError } from "./store"
export type { MemoryRecord } from "./types"

interface SearchParams {
  userId: string
  query: string
  aiGatewayApiKey: string
  signal?: AbortSignal
}

export async function searchUserMemory(
  params: SearchParams
): Promise<MemoryRecord[]> {
  if (!AGENT_MEMORY_ENABLED) {
    return []
  }

  const trimmed = params.query.trim()
  if (!trimmed) {
    return []
  }

  try {
    const embedding = await embedMemoryText(trimmed, {
      aiGatewayApiKey: params.aiGatewayApiKey,
      signal: params.signal,
    })
    return await searchMemoriesByVector({
      userId: params.userId,
      embedding,
      topK: AGENT_MEMORY_SEARCH_TOP_K,
      similarityThreshold: AGENT_MEMORY_SEARCH_THRESHOLD,
    })
  } catch (error) {
    if (isMemoryStoreNotInitializedError(error)) {
      logger.warn(
        "Memory store is not initialized; run pnpm app:migrate to enable memory.",
        { userId: params.userId }
      )
      return []
    }

    logger.warn("Failed to search user memory; continuing without it.", {
      userId: params.userId,
      error,
    })
    return []
  }
}

interface RecordParams {
  userId: string
  userMessage: string
  aiGatewayApiKey: string
  signal?: AbortSignal
}

export async function recordUserMemory(params: RecordParams): Promise<{
  extracted: number
  inserted: number
}> {
  if (!AGENT_MEMORY_ENABLED) {
    return { extracted: 0, inserted: 0 }
  }

  const trimmed = params.userMessage.trim()
  if (!trimmed) {
    return { extracted: 0, inserted: 0 }
  }

  let facts: string[] = []
  try {
    facts = await extractMemoryFacts({
      userMessage: trimmed,
      aiGatewayApiKey: params.aiGatewayApiKey,
      signal: params.signal,
    })
  } catch (error) {
    logger.warn("Failed to extract memory facts; skipping memory write.", {
      userId: params.userId,
      error,
    })
    return { extracted: 0, inserted: 0 }
  }

  const limited = facts.slice(0, AGENT_MEMORY_MAX_FACTS_PER_TURN)
  if (limited.length === 0) {
    return { extracted: 0, inserted: 0 }
  }

  let embeddings: number[][]
  try {
    embeddings = await embedMemoryTexts(limited, {
      aiGatewayApiKey: params.aiGatewayApiKey,
      signal: params.signal,
    })
  } catch (error) {
    logger.warn("Failed to embed memory facts; skipping memory write.", {
      userId: params.userId,
      error,
    })
    return { extracted: limited.length, inserted: 0 }
  }

  let inserted = 0
  for (let index = 0; index < limited.length; index += 1) {
    const fact = limited[index]
    const embedding = embeddings[index]
    if (!fact || !embedding) {
      continue
    }

    try {
      const duplicates = await searchMemoriesByVector({
        userId: params.userId,
        embedding,
        topK: 1,
        similarityThreshold: AGENT_MEMORY_DEDUP_THRESHOLD,
      })
      if (duplicates.length > 0) {
        continue
      }

      await insertMemory({
        userId: params.userId,
        fact,
        embedding,
        metadata: { source: "agent_turn" },
      })
      inserted += 1
    } catch (error) {
      if (isMemoryStoreNotInitializedError(error)) {
        logger.warn(
          "Memory store is not initialized; run pnpm app:migrate to enable memory.",
          { userId: params.userId }
        )
        return { extracted: limited.length, inserted }
      }

      logger.warn("Failed to persist memory fact.", {
        userId: params.userId,
        error,
      })
    }
  }

  if (inserted > 0) {
    logger.info("Persisted user memory facts.", {
      userId: params.userId,
      extracted: limited.length,
      inserted,
    })
  }

  return { extracted: limited.length, inserted }
}
