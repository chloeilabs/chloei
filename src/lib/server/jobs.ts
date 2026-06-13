import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "./postgres"

export const AGENT_JOB_TYPES = [
  "agent/report.requested",
  "market/watchlist.refresh.requested",
  "trading/analysis.requested",
] as const

export const AGENT_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const

export type AgentJobType = (typeof AGENT_JOB_TYPES)[number]
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number]

export interface AgentJob {
  id: string
  userId: string
  type: AgentJobType
  status: AgentJobStatus
  payload: unknown
  result: unknown
  error: string | null
  createdAt: string
  updatedAt: string
}

interface AgentJobRow {
  id: string
  userId: string
  type: AgentJobType
  status: AgentJobStatus
  payload: unknown
  result: unknown
  error: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

function toAgentJob(row: AgentJobRow): AgentJob {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    status: row.status,
    payload: row.payload,
    result: row.result,
    error: row.error,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}

export async function createAgentJob(params: {
  userId: string
  type: AgentJobType
  payload: unknown
  idempotencyKey: string
}): Promise<AgentJob> {
  const database = getDatabase()
  const id = randomUUID()
  const now = new Date()
  const result = await sql<AgentJobRow>`
    INSERT INTO agent_job (
      id,
      "userId",
      type,
      status,
      payload,
      "idempotencyKey",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${id},
      ${params.userId},
      ${params.type},
      'queued',
      CAST(${JSON.stringify(params.payload)} AS jsonb),
      ${params.idempotencyKey},
      ${now},
      ${now}
    )
    ON CONFLICT ("userId", "idempotencyKey")
    DO UPDATE SET
      "updatedAt" = agent_job."updatedAt"
    RETURNING
      id,
      "userId",
      type,
      status,
      payload,
      result,
      error,
      "createdAt",
      "updatedAt"
  `.execute(database)

  const row = result.rows[0]
  if (!row) {
    throw new Error("Agent job could not be created.")
  }

  return toAgentJob(row)
}

export async function getAgentJobForUser(params: {
  userId: string
  jobId: string
}): Promise<AgentJob | null> {
  const database = getDatabase()
  const result = await sql<AgentJobRow>`
    SELECT
      id,
      "userId",
      type,
      status,
      payload,
      result,
      error,
      "createdAt",
      "updatedAt"
    FROM agent_job
    WHERE "userId" = ${params.userId}
      AND id = ${params.jobId}
    LIMIT 1
  `.execute(database)

  const row = result.rows[0]
  return row ? toAgentJob(row) : null
}

export async function updateAgentJobStatus(params: {
  jobId: string
  status: AgentJobStatus
  result?: unknown
  error?: string | null
}): Promise<void> {
  const database = getDatabase()
  await sql`
    UPDATE agent_job
    SET
      status = ${params.status},
      result = CASE
        WHEN ${params.result === undefined} THEN result
        ELSE CAST(${JSON.stringify(params.result ?? null)} AS jsonb)
      END,
      error = CASE
        WHEN ${params.error === undefined} THEN error
        ELSE ${params.error}
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${params.jobId}
  `.execute(database)
}
