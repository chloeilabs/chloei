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
  cloudAgentArtifactCreateSchema,
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
  // Defense in depth: the input type is enforced at compile time, but
  // also run it through the Zod schema so things like the metadata
  // default and field caps apply consistently even when callers hand-
  // build the input object (e.g. the runtime). Keeps the schema from
  // being dead code.
  const input = cloudAgentArtifactCreateSchema.parse(params.input)
  if (isCloudAgentMockModeEnabled()) {
    return mockCreateArtifact({ ...params, input })
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
        ${input.kind},
        ${input.label},
        ${input.mediaType ?? null},
        ${input.sizeBytes ?? null},
        ${input.url ?? null},
        ${input.blobPathname ?? null},
        CAST(${JSON.stringify(input.metadata)} AS jsonb),
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
