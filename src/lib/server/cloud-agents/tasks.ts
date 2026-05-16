import { randomUUID } from "node:crypto"

import { sql } from "kysely"

import { getDatabase } from "@/lib/server/postgres"
import {
  type CloudAgentTask,
  type CloudAgentTaskStatus,
  isTerminalCloudAgentTaskStatus,
} from "@/lib/shared/cloud-agents"

import {
  CloudAgentNotFoundError,
  CloudAgentTransitionError,
  wrapCloudAgentStoreError,
} from "./errors"
import {
  isCloudAgentMockModeEnabled,
  mockCountActiveTasks,
  mockCreateTask,
  mockGetTask,
  mockListTasks,
  mockUpdateTask,
} from "./mock-store"
import { type CloudAgentTaskRow, parseTaskRow } from "./payloads"

const SELECT_FIELDS = sql`
  id,
  "environmentId",
  prompt,
  status,
  phase,
  branch,
  "sandboxId",
  "snapshotId",
  "prUrl",
  "previewUrl",
  summary,
  error,
  "createdAt",
  "updatedAt",
  "completedAt"
`

export async function listCloudAgentTasks(params: {
  userId: string
  environmentId?: string
  limit?: number
}): Promise<CloudAgentTask[]> {
  if (isCloudAgentMockModeEnabled()) {
    return mockListTasks(params)
  }
  const database = getDatabase()
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  try {
    const result = params.environmentId
      ? await sql<CloudAgentTaskRow>`
          SELECT ${SELECT_FIELDS}
          FROM cloud_agent_task
          WHERE "userId" = ${params.userId}
            AND "environmentId" = ${params.environmentId}
          ORDER BY "updatedAt" DESC, id ASC
          LIMIT ${limit}
        `.execute(database)
      : await sql<CloudAgentTaskRow>`
          SELECT ${SELECT_FIELDS}
          FROM cloud_agent_task
          WHERE "userId" = ${params.userId}
          ORDER BY "updatedAt" DESC, id ASC
          LIMIT ${limit}
        `.execute(database)
    return result.rows.map(parseTaskRow)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function findCloudAgentTaskByBranch(params: {
  userId: string
  branch: string
}): Promise<CloudAgentTask | null> {
  if (isCloudAgentMockModeEnabled()) {
    const tasks = mockListTasks({ userId: params.userId })
    return tasks.find((task) => task.branch === params.branch) ?? null
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentTaskRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_task
      WHERE "userId" = ${params.userId}
        AND branch = ${params.branch}
      ORDER BY "updatedAt" DESC, id ASC
      LIMIT 1
    `.execute(database)
    const row = result.rows[0]
    return row ? parseTaskRow(row) : null
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function getCloudAgentTask(
  userId: string,
  taskId: string
): Promise<CloudAgentTask | null> {
  if (isCloudAgentMockModeEnabled()) {
    return mockGetTask(userId, taskId)
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentTaskRow>`
      SELECT ${SELECT_FIELDS}
      FROM cloud_agent_task
      WHERE "userId" = ${userId}
        AND id = ${taskId}
      LIMIT 1
    `.execute(database)
    const row = result.rows[0]
    return row ? parseTaskRow(row) : null
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function createCloudAgentTask(params: {
  userId: string
  environmentId: string
  prompt: string
  maxConcurrentPerUser?: number
}): Promise<CloudAgentTask> {
  if (isCloudAgentMockModeEnabled()) {
    if (params.maxConcurrentPerUser !== undefined) {
      const active = mockCountActiveTasks(params.userId)
      if (active >= params.maxConcurrentPerUser) {
        throw new CloudAgentTransitionError(
          "Cloud agent concurrency limit reached."
        )
      }
    }
    return mockCreateTask({
      userId: params.userId,
      environmentId: params.environmentId,
      prompt: params.prompt,
    })
  }
  const database = getDatabase()
  const id = randomUUID()
  const now = new Date()
  const maxConcurrent = params.maxConcurrentPerUser ?? null
  try {
    // INSERT...SELECT keeps the count-and-create atomic at the DB level:
    // the SELECT runs against the same snapshot as the conditional INSERT,
    // so two concurrent requests can't both pass the cap.
    const result = await sql<CloudAgentTaskRow>`
      INSERT INTO cloud_agent_task (
        id,
        "userId",
        "environmentId",
        prompt,
        status,
        "createdAt",
        "updatedAt"
      )
      SELECT
        ${id},
        ${params.userId},
        ${params.environmentId},
        ${params.prompt},
        'queued',
        ${now},
        ${now}
      WHERE
        ${maxConcurrent} IS NULL
        OR (
          SELECT COUNT(*) FROM cloud_agent_task
          WHERE "userId" = ${params.userId}
            AND status NOT IN ('completed', 'failed', 'cancelled')
        ) < ${maxConcurrent}
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new CloudAgentTransitionError(
        "Cloud agent concurrency limit reached."
      )
    }
    return parseTaskRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export interface CloudAgentTaskUpdate {
  status?: CloudAgentTaskStatus
  phase?: string | null
  branch?: string | null
  sandboxId?: string | null
  snapshotId?: string | null
  prUrl?: string | null
  previewUrl?: string | null
  summary?: string | null
  error?: string | null
}

export async function updateCloudAgentTask(
  userId: string,
  taskId: string,
  update: CloudAgentTaskUpdate
): Promise<CloudAgentTask> {
  if (isCloudAgentMockModeEnabled()) {
    return mockUpdateTask(userId, taskId, update)
  }
  const database = getDatabase()
  const status = update.status
  const shouldStampCompletion =
    status !== undefined && isTerminalCloudAgentTaskStatus(status)
  try {
    const result = await sql<CloudAgentTaskRow>`
      UPDATE cloud_agent_task
      SET
        status = COALESCE(${status ?? null}, status),
        phase = CASE
          WHEN ${update.phase === undefined} THEN phase
          ELSE ${update.phase}
        END,
        branch = CASE
          WHEN ${update.branch === undefined} THEN branch
          ELSE ${update.branch}
        END,
        "sandboxId" = CASE
          WHEN ${update.sandboxId === undefined} THEN "sandboxId"
          ELSE ${update.sandboxId}
        END,
        "snapshotId" = CASE
          WHEN ${update.snapshotId === undefined} THEN "snapshotId"
          ELSE ${update.snapshotId}
        END,
        "prUrl" = CASE
          WHEN ${update.prUrl === undefined} THEN "prUrl"
          ELSE ${update.prUrl}
        END,
        "previewUrl" = CASE
          WHEN ${update.previewUrl === undefined} THEN "previewUrl"
          ELSE ${update.previewUrl}
        END,
        summary = CASE
          WHEN ${update.summary === undefined} THEN summary
          ELSE ${update.summary}
        END,
        error = CASE
          WHEN ${update.error === undefined} THEN error
          ELSE ${update.error}
        END,
        "updatedAt" = CURRENT_TIMESTAMP,
        "completedAt" = CASE
          WHEN ${shouldStampCompletion} AND "completedAt" IS NULL
            THEN CURRENT_TIMESTAMP
          ELSE "completedAt"
        END
      WHERE "userId" = ${userId}
        AND id = ${taskId}
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      throw new CloudAgentNotFoundError("task", taskId)
    }
    return parseTaskRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function requireCloudAgentTaskTransition(params: {
  userId: string
  taskId: string
  from: CloudAgentTaskStatus[]
}): Promise<CloudAgentTask> {
  const task = await getCloudAgentTask(params.userId, params.taskId)
  if (!task) {
    throw new CloudAgentNotFoundError("task", params.taskId)
  }
  if (!params.from.includes(task.status)) {
    throw new CloudAgentTransitionError(
      `Task ${params.taskId} is in status ${task.status}; expected one of [${params.from.join(", ")}].`
    )
  }
  return task
}
