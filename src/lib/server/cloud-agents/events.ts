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

// Returns the latest pending `approval_required` event for a task, or
// null if none exist. Used by the approve route to confirm the
// supplied approvalId matches the approval the runtime actually
// requested before forwarding the decision to the runtime.
export async function getLatestApprovalRequiredId(params: {
  userId: string
  taskId: string
}): Promise<string | null> {
  if (isCloudAgentMockModeEnabled()) {
    const events = mockListEvents({
      userId: params.userId,
      taskId: params.taskId,
      limit: 1000,
    })
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.payload.kind === "approval_required") {
        return event.payload.approvalId
      }
    }
    return null
  }
  const database = getDatabase()
  try {
    const result = await sql<{ approvalId: string | null }>`
      SELECT payload->>'approvalId' AS "approvalId"
      FROM cloud_agent_task_event
      WHERE "userId" = ${params.userId}
        AND "taskId" = ${params.taskId}
        AND kind = 'approval_required'
      ORDER BY seq DESC
      LIMIT 1
    `.execute(database)
    return result.rows[0]?.approvalId ?? null
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
