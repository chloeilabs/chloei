import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "@/lib/server/postgres"
import type { CloudAgentArtifact } from "@/lib/shared/cloud-agents"

import { wrapCloudAgentStoreError } from "./errors"
import {
  isCloudAgentMockModeEnabled,
  mockCreateArtifact,
  mockListArtifacts,
} from "./mock-store"
import {
  type CloudAgentArtifactCreateInput,
  type CloudAgentArtifactRow,
  parseArtifactRow,
} from "./payloads"

const SELECT_FIELDS = sql`
  id,
  "taskId",
  kind,
  label,
  "mediaType",
  "sizeBytes",
  url,
  "blobPathname",
  metadata,
  "createdAt"
`

export async function createCloudAgentArtifact(params: {
  userId: string
  taskId: string
  input: CloudAgentArtifactCreateInput
}): Promise<CloudAgentArtifact> {
  if (isCloudAgentMockModeEnabled()) {
    return mockCreateArtifact(params)
  }
  const database = getDatabase()
  const id = randomUUID()
  const now = new Date()
  try {
    const result = await sql<CloudAgentArtifactRow>`
      INSERT INTO cloud_agent_artifact (
        id,
        "userId",
        "taskId",
        kind,
        label,
        "mediaType",
        "sizeBytes",
        url,
        "blobPathname",
        metadata,
        "createdAt"
      )
      VALUES (
        ${id},
        ${params.userId},
        ${params.taskId},
        ${params.input.kind},
        ${params.input.label},
        ${params.input.mediaType ?? null},
        ${params.input.sizeBytes ?? null},
        ${params.input.url ?? null},
        ${params.input.blobPathname ?? null},
        CAST(${JSON.stringify(params.input.metadata)} AS jsonb),
        ${now}
      )
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new Error("Cloud agent artifact could not be created.")
    }
    return parseArtifactRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function listCloudAgentArtifacts(params: {
  userId: string
  taskId: string
}): Promise<CloudAgentArtifact[]> {
  if (isCloudAgentMockModeEnabled()) {
    return mockListArtifacts(params)
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentArtifactRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_artifact
      WHERE "userId" = ${params.userId}
        AND "taskId" = ${params.taskId}
      ORDER BY "createdAt" DESC, id ASC
    `.execute(database)
    return result.rows.map(parseArtifactRow)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}
