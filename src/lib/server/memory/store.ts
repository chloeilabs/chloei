import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "@/lib/server/postgres"

import type { MemoryRecord } from "./types"

interface MemoryRow {
  id: string
  fact: string
  createdAt: Date
  updatedAt: Date
  similarity: number | null
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`
}

export async function searchMemoriesByVector(params: {
  userId: string
  embedding: readonly number[]
  topK: number
  similarityThreshold: number
}): Promise<MemoryRecord[]> {
  const db = getDatabase()
  const literal = vectorLiteral(params.embedding)
  const rows = await sql<MemoryRow>`
    SELECT
      id,
      fact,
      "createdAt",
      "updatedAt",
      1 - (embedding <=> ${literal}::vector) AS similarity
    FROM agent_memory
    WHERE "userId" = ${params.userId}
      AND 1 - (embedding <=> ${literal}::vector) >= ${params.similarityThreshold}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${params.topK}
  `.execute(db)

  return rows.rows.map((row) => ({
    id: row.id,
    fact: row.fact,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    similarity: row.similarity ?? undefined,
  }))
}

export async function insertMemory(params: {
  userId: string
  fact: string
  embedding: readonly number[]
  metadata?: Record<string, unknown>
}): Promise<string> {
  const db = getDatabase()
  const id = randomUUID()
  const literal = vectorLiteral(params.embedding)
  const metadata = JSON.stringify(params.metadata ?? {})

  await sql`
    INSERT INTO agent_memory (id, "userId", fact, embedding, metadata)
    VALUES (${id}, ${params.userId}, ${params.fact}, ${literal}::vector, ${metadata}::jsonb)
  `.execute(db)

  return id
}

export function isMemoryStoreNotInitializedError(
  error: unknown
): error is Error {
  if (!(error instanceof Error)) {
    return false
  }

  const code = (error as { code?: unknown }).code
  if (typeof code !== "string") {
    return false
  }

  return code === "42P01" || code === "42703" || code === "42704"
}
