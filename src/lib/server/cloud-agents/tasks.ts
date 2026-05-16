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
  mockListAllUserIds,
  mockListEnvironments,
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

export interface CloudAgentTaskWithOwner {
  userId: string
  task: CloudAgentTask
}

export async function findCloudAgentTaskAnyUserById(
  taskId: string
): Promise<CloudAgentTaskWithOwner | null> {
  if (isCloudAgentMockModeEnabled()) {
    for (const userId of mockListAllUserIds()) {
      const task = mockGetTask(userId, taskId)
      if (task) return { userId, task }
    }
    return null
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentTaskRow & { userId: string }>`
      SELECT "userId", ${SELECT_FIELDS}
      FROM cloud_agent_task
      WHERE id = ${taskId}
      LIMIT 1
    `.execute(database)
    const row = result.rows[0]
    return row ? { userId: row.userId, task: parseTaskRow(row) } : null
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}

export async function findCloudAgentTaskAnyUserByProjectAndBranch(params: {
  vercelProjectId: string
  branch: string
}): Promise<CloudAgentTaskWithOwner | null> {
  if (isCloudAgentMockModeEnabled()) {
    // Mirror the SQL ORDER BY updatedAt DESC LIMIT 1 by collecting
    // every per-user match and picking the globally most recent.
    // Map insertion order would otherwise return whichever user was
    // created first, diverging from the real-DB lookup.
    const matches: CloudAgentTaskWithOwner[] = []
    for (const userId of mockListAllUserIds()) {
      const environments = mockListEnvironments(userId)
      const matchingEnvIds = new Set(
        environments
          .filter((env) => env.vercelProjectId === params.vercelProjectId)
          .map((env) => env.id)
      )
      if (matchingEnvIds.size === 0) continue
      const tasks = mockListTasks({ userId })
      for (const task of tasks) {
        if (
          task.branch === params.branch &&
          matchingEnvIds.has(task.environmentId)
        ) {
          matches.push({ userId, task })
        }
      }
    }
    if (matches.length === 0) return null
    matches.sort((a, b) => {
      const order = Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt)
      return order !== 0 ? order : a.task.id.localeCompare(b.task.id)
    })
    return matches[0] ?? null
  }
  const database = getDatabase()
  try {
    // Scope the branch lookup to the deployment's Vercel project so two
    // unrelated users / environments that happen to use the same branch
    // name (e.g. main) never see each other's previewUrl get overwritten.
    // The join enforces (userId, environmentId) co-tenancy via the
    // cloud_agent_task foreign key.
    const result = await sql<CloudAgentTaskRow & { userId: string }>`
      SELECT
        t."userId",
        t.id,
        t."environmentId",
        t.prompt,
        t.status,
        t.phase,
        t.branch,
        t."sandboxId",
        t."snapshotId",
        t."prUrl",
        t."previewUrl",
        t.summary,
        t.error,
        t."createdAt",
        t."updatedAt",
        t."completedAt"
      FROM cloud_agent_task AS t
      INNER JOIN cloud_agent_environment AS e
        ON e."userId" = t."userId" AND e.id = t."environmentId"
      WHERE t.branch = ${params.branch}
        AND e."vercelProjectId" = ${params.vercelProjectId}
      ORDER BY t."updatedAt" DESC, t.id ASC
      LIMIT 1
    `.execute(database)
    const row = result.rows[0]
    return row ? { userId: row.userId, task: parseTaskRow(row) } : null
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
    // Run the count-and-create inside a transaction with a per-user advisory
    // lock so two concurrent requests can't both pass the cap under READ
    // COMMITTED. The lock is keyed on hashtext(userId) so it's bounded per
    // user, and pg_advisory_xact_lock auto-releases at COMMIT / ROLLBACK.
    const result = await database.transaction().execute(async (trx) => {
      if (maxConcurrent !== null) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${params.userId})::int8)`.execute(
          trx
        )
      }
      return sql<CloudAgentTaskRow>`
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
      `.execute(trx)
    })
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

// Atomic conditional update: only writes if the row's current status
// is in `allowedFromStatuses`. Returns null if the row no longer
// qualifies (e.g. a concurrent cancel moved it to `cancelled`). Used
// by the push flow so completion of a shipped PR never silently
// overwrites a user cancel mid-push.
export async function updateCloudAgentTaskIfStatusIn(params: {
  userId: string
  taskId: string
  allowedFromStatuses: CloudAgentTaskStatus[]
  update: CloudAgentTaskUpdate
}): Promise<CloudAgentTask | null> {
  if (isCloudAgentMockModeEnabled()) {
    const existing = mockGetTask(params.userId, params.taskId)
    if (!existing) return null
    if (!params.allowedFromStatuses.includes(existing.status)) return null
    return mockUpdateTask(params.userId, params.taskId, params.update)
  }
  const database = getDatabase()
  const { update } = params
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
      WHERE "userId" = ${params.userId}
        AND id = ${params.taskId}
        AND status = ANY(${params.allowedFromStatuses}::text[])
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    return row ? parseTaskRow(row) : null
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

// Atomic cancel: the row is only transitioned to "cancelled" if its
// current status is still in `allowedFromStatuses`. If the background
// runtime has already moved the task to a terminal state in the
// window between the route handler reading status and writing
// "cancelled", the UPDATE matches 0 rows and the helper throws a
// CloudAgentTransitionError so the route returns 409 instead of
// clobbering the completed task's prUrl/summary.
export async function cancelCloudAgentTaskIfActive(params: {
  userId: string
  taskId: string
  allowedFromStatuses: CloudAgentTaskStatus[]
  phase: string
  summary: string
}): Promise<CloudAgentTask> {
  if (isCloudAgentMockModeEnabled()) {
    const existing = mockGetTask(params.userId, params.taskId)
    if (!existing) {
      throw new CloudAgentNotFoundError("task", params.taskId)
    }
    if (!params.allowedFromStatuses.includes(existing.status)) {
      throw new CloudAgentTransitionError(
        `Task ${params.taskId} is in status ${existing.status}; expected one of [${params.allowedFromStatuses.join(", ")}].`
      )
    }
    return mockUpdateTask(params.userId, params.taskId, {
      status: "cancelled",
      phase: params.phase,
      summary: params.summary,
    })
  }
  const database = getDatabase()
  try {
    const result = await sql<CloudAgentTaskRow>`
      UPDATE cloud_agent_task
      SET
        status = 'cancelled',
        phase = ${params.phase},
        summary = ${params.summary},
        "updatedAt" = CURRENT_TIMESTAMP,
        "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
      WHERE "userId" = ${params.userId}
        AND id = ${params.taskId}
        AND status = ANY(${params.allowedFromStatuses}::text[])
      RETURNING ${SELECT_FIELDS}
    `.execute(database)
    const row = result.rows[0]
    if (!row) {
      const current = await getCloudAgentTask(params.userId, params.taskId)
      if (!current) {
        throw new CloudAgentNotFoundError("task", params.taskId)
      }
      throw new CloudAgentTransitionError(
        `Task ${params.taskId} is in status ${current.status}; expected one of [${params.allowedFromStatuses.join(", ")}].`
      )
    }
    return parseTaskRow(row)
  } catch (error) {
    throw wrapCloudAgentStoreError(error)
  }
}
