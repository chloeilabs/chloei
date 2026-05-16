import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "@/lib/server/postgres"
import type {
  CloudAgentEvent,
  CloudAgentTaskEvent,
} from "@/lib/shared/cloud-agents"

import { wrapCloudAgentStoreError } from "./errors"
import {
  isCloudAgentMockModeEnabled,
  mockAppendEvent,
  mockListEvents,
} from "./mock-store"
import {
  cloudAgentEventPayloadSchema,
  type CloudAgentTaskEventRow,
  parseTaskEventRow,
} from "./payloads"

const SELECT_FIELDS = sql`
  id,
  "taskId",
  seq,
  payload,
  "createdAt"
`

export async function appendCloudAgentTaskEvent(params: {
  userId: string
  taskId: string
  payload: CloudAgentEvent
}): Promise<CloudAgentTaskEvent> {
  if (isCloudAgentMockModeEnabled()) {
    return mockAppendEvent({
      userId: params.userId,
      taskId: params.taskId,
      payload: cloudAgentEventPayloadSchema.parse(params.payload),
    })
  }
  const database = getDatabase()
  const payload = cloudAgentEventPayloadSchema.parse(params.payload)
  const id = randomUUID()
  const now = new Date()
  try {
    const result = await sql<CloudAgentTaskEventRow>`
      INSERT INTO cloud_agent_task_event (
        id,
        "userId",
        "taskId",
        kind,
        payload,
        "createdAt"
      )
      VALUES (
        ${id},
        ${params.userId},
        ${params.taskId},
        ${payload.kind},
        CAST(${JSON.stringify(payload)} AS jsonb),
        ${now}
      )
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new Error("Cloud agent task event could not be appended.")
    }
    return parseTaskEventRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function listCloudAgentTaskEvents(params: {
  userId: string
  taskId: string
  afterSeq?: number
  limit?: number
}): Promise<CloudAgentTaskEvent[]> {
  if (isCloudAgentMockModeEnabled()) {
    return mockListEvents(params)
  }
  const database = getDatabase()
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 1000)
  const afterSeq = params.afterSeq ?? 0
  try {
    const result = await sql<CloudAgentTaskEventRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_task_event
      WHERE "userId" = ${params.userId}
        AND "taskId" = ${params.taskId}
        AND seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${limit}
    `.execute(database)
    return result.rows.map(parseTaskEventRow)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function getLatestCloudAgentTaskEventSeq(params: {
  userId: string
  taskId: string
}): Promise<number> {
  const database = getDatabase()
  try {
    const result = await sql<{ max: string | number | bigint | null }>`
      SELECT MAX(seq) AS max
      FROM cloud_agent_task_event
      WHERE "userId" = ${params.userId}
        AND "taskId" = ${params.taskId}
    `.execute(database)
    const row = result.rows[0]
    if (row?.max == null) {
      return 0
    }
    return Number(row.max)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}
