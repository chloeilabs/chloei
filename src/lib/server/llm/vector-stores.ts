import { createLogger } from "@/lib/logger"

import { getOpenAiClient } from "./openai-raw-client"

const logger = createLogger("vector-stores")

// How long the readiness poll may block the request. A store that is still
// indexing after this window is used anyway — file_search returns what is
// ready — so the cap only bounds added latency.
const VECTOR_STORE_READY_TIMEOUT_MS = 10_000
const VECTOR_STORE_POLL_INTERVAL_MS = 500
// Stores expire on their own; no cleanup job needed.
const VECTOR_STORE_EXPIRY_DAYS = 7

/**
 * Creates a per-request vector store over the request's PDF attachment file
 * ids so file_search-enabled goblins can search the user's documents. Waits
 * briefly for indexing; any failure returns null and the run proceeds without
 * file_search (the manager still sees the files inline).
 */
export async function ensureGoblinsVectorStore(params: {
  openAiApiKey: string
  fileIds: string[]
  requestId?: string
}): Promise<string | null> {
  const fileIds = params.fileIds.filter((fileId) => fileId.trim().length > 0)
  if (fileIds.length === 0) {
    return null
  }

  const startedAt = Date.now()
  try {
    const client = getOpenAiClient(params.openAiApiKey)
    const store = await client.vectorStores.create({
      name: `goblins-${params.requestId ?? crypto.randomUUID()}`,
      file_ids: fileIds,
      expires_after: {
        anchor: "last_active_at",
        days: VECTOR_STORE_EXPIRY_DAYS,
      },
    })

    let inProgress = store.file_counts.in_progress
    while (
      inProgress > 0 &&
      Date.now() - startedAt < VECTOR_STORE_READY_TIMEOUT_MS
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, VECTOR_STORE_POLL_INTERVAL_MS)
      )
      const current = await client.vectorStores.retrieve(store.id)
      inProgress = current.file_counts.in_progress
    }

    logger.info("Goblins vector store ready.", {
      requestId: params.requestId,
      vectorStoreId: store.id,
      fileCount: fileIds.length,
      pendingFiles: inProgress,
      durationMs: Date.now() - startedAt,
    })
    return store.id
  } catch (error) {
    logger.warn(
      "Vector store creation failed; goblins run without file_search.",
      {
        requestId: params.requestId,
        fileCount: fileIds.length,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    )
    return null
  }
}
