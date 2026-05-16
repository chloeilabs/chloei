import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "@/lib/server/postgres"
import type { CloudAgentEnvironment } from "@/lib/shared/cloud-agents"

import { CloudAgentNotFoundError, wrapCloudAgentStoreError } from "./errors"
import {
  isCloudAgentMockModeEnabled,
  mockCreateEnvironment,
  mockDeleteEnvironment,
  mockGetEnvironment,
  mockListEnvironments,
  mockUpdateEnvironment,
} from "./mock-store"
import {
  type CloudAgentEnvironmentCreateInput,
  type CloudAgentEnvironmentRow,
  type CloudAgentEnvironmentUpdateInput,
  parseEnvironmentRow,
} from "./payloads"

const SELECT_FIELDS = sql`
  id,
  name,
  "repoProvider",
  "repoOwner",
  "repoName",
  "baseBranch",
  "setupCommand",
  "testCommand",
  "devCommand",
  "networkPolicy",
  "vercelProjectId",
  "sandboxRuntime",
  "createdAt",
  "updatedAt"
`

export async function listCloudAgentEnvironments(
  userId: string
): Promise<CloudAgentEnvironment[]> {
  if (isCloudAgentMockModeEnabled()) {
    return mockListEnvironments(userId)
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentEnvironmentRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_environment
      WHERE "userId" = ${userId}
      ORDER BY "updatedAt" DESC, id ASC
    `.execute(database)
    return result.rows.map(parseEnvironmentRow)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function getCloudAgentEnvironment(
  userId: string,
  environmentId: string
): Promise<CloudAgentEnvironment | null> {
  if (isCloudAgentMockModeEnabled()) {
    return mockGetEnvironment(userId, environmentId)
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentEnvironmentRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_environment
      WHERE "userId" = ${userId}
        AND id = ${environmentId}
      LIMIT 1
    `.execute(database)
    const row = result.rows[0]
    return row ? parseEnvironmentRow(row) : null
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function createCloudAgentEnvironment(
  userId: string,
  input: CloudAgentEnvironmentCreateInput
): Promise<CloudAgentEnvironment> {
  if (isCloudAgentMockModeEnabled()) {
    return mockCreateEnvironment(userId, input)
  }
  const database = getDatabase()
  const id = randomUUID()
  const now = new Date()
  try {
    const result = await sql<CloudAgentEnvironmentRow>`
      INSERT INTO cloud_agent_environment (
        id,
        "userId",
        name,
        "repoProvider",
        "repoOwner",
        "repoName",
        "baseBranch",
        "setupCommand",
        "testCommand",
        "devCommand",
        "networkPolicy",
        "vercelProjectId",
        "sandboxRuntime",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${id},
        ${userId},
        ${input.name},
        ${input.repoProvider},
        ${input.repoOwner},
        ${input.repoName},
        ${input.baseBranch},
        ${input.setupCommand ?? null},
        ${input.testCommand ?? null},
        ${input.devCommand ?? null},
        CAST(${JSON.stringify(input.networkPolicy)} AS jsonb),
        ${input.vercelProjectId ?? null},
        ${input.sandboxRuntime},
        ${now},
        ${now}
      )
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new Error("Cloud agent environment could not be created.")
    }
    return parseEnvironmentRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function updateCloudAgentEnvironment(
  userId: string,
  environmentId: string,
  input: CloudAgentEnvironmentUpdateInput
): Promise<CloudAgentEnvironment> {
  if (isCloudAgentMockModeEnabled()) {
    return mockUpdateEnvironment(userId, environmentId, input)
  }
  const existing = await getCloudAgentEnvironment(userId, environmentId)
  if (!existing) {
    throw new CloudAgentNotFoundError("environment", environmentId)
  }

  const merged = {
    name: input.name ?? existing.name,
    baseBranch: input.baseBranch ?? existing.baseBranch,
    setupCommand:
      input.setupCommand === undefined
        ? (existing.setupCommand ?? null)
        : (input.setupCommand ?? null),
    testCommand:
      input.testCommand === undefined
        ? (existing.testCommand ?? null)
        : (input.testCommand ?? null),
    devCommand:
      input.devCommand === undefined
        ? (existing.devCommand ?? null)
        : (input.devCommand ?? null),
    networkPolicy: input.networkPolicy ?? existing.networkPolicy,
    vercelProjectId:
      input.vercelProjectId === undefined
        ? (existing.vercelProjectId ?? null)
        : (input.vercelProjectId ?? null),
    sandboxRuntime: input.sandboxRuntime ?? existing.sandboxRuntime,
  }

  const database = getDatabase()
  try {
    const result = await sql<CloudAgentEnvironmentRow>`
      UPDATE cloud_agent_environment
      SET
        name = ${merged.name},
        "baseBranch" = ${merged.baseBranch},
        "setupCommand" = ${merged.setupCommand},
        "testCommand" = ${merged.testCommand},
        "devCommand" = ${merged.devCommand},
        "networkPolicy" = CAST(${JSON.stringify(merged.networkPolicy)} AS jsonb),
        "vercelProjectId" = ${merged.vercelProjectId},
        "sandboxRuntime" = ${merged.sandboxRuntime},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = ${userId}
        AND id = ${environmentId}
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new CloudAgentNotFoundError("environment", environmentId)
    }
    return parseEnvironmentRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function deleteCloudAgentEnvironment(
  userId: string,
  environmentId: string
): Promise<void> {
  if (isCloudAgentMockModeEnabled()) {
    mockDeleteEnvironment(userId, environmentId)
    return
  }
  const database = getDatabase()
  try {
    await sql`
      DELETE FROM cloud_agent_environment
      WHERE "userId" = ${userId}
        AND id = ${environmentId}
    `.execute(database)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}
