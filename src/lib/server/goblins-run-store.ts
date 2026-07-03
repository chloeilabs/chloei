import { sql } from "kysely"

import { createLogger } from "@/lib/logger"
import { type AgentStreamEvent } from "@/lib/shared"

import { getDatabase } from "./postgres"

const logger = createLogger("goblins-run-store")

const GOBLINS_RUN_SETUP_MESSAGE =
  "Goblins run storage is not initialized. Run `pnpm app:migrate` to initialize app tables."
const POSTGRES_UNDEFINED_TABLE_ERROR_CODE = "42P01"
const POSTGRES_UNDEFINED_COLUMN_ERROR_CODE = "42703"

// Lease horizon for one continuation segment. Comfortably above the segment
// wall-clock budget so only a genuinely dead invocation loses its lease.
const GOBLINS_RUN_LEASE_MS = 13 * 60 * 1000
// Abandoned runs expire lazily on read; no cron by design.
export const GOBLINS_RUN_TTL_MS = 3 * 60 * 60 * 1000
// Soft cap on the persisted event log; beyond it new events are dropped (the
// authoritative final answer still lands in the thread message).
const GOBLINS_RUN_MAX_EVENTS = 5000

class GoblinsRunStoreNotInitializedError extends Error {
  constructor() {
    super(GOBLINS_RUN_SETUP_MESSAGE)
    this.name = "GoblinsRunStoreNotInitializedError"
  }
}

function isPostgresErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}

function wrapGoblinsRunStoreError(error: unknown): Error {
  if (
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_TABLE_ERROR_CODE) ||
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_COLUMN_ERROR_CODE)
  ) {
    return new GoblinsRunStoreNotInitializedError()
  }
  return error instanceof Error
    ? error
    : new Error("Unknown goblins run store error.")
}

export function isGoblinsRunStoreNotInitializedError(
  error: unknown
): error is GoblinsRunStoreNotInitializedError {
  return error instanceof GoblinsRunStoreNotInitializedError
}

export const GOBLINS_RUN_STATUSES = [
  "pending_dispatch",
  "awaiting_manager",
  "executing_tools",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const
export type GoblinsRunStatus = (typeof GOBLINS_RUN_STATUSES)[number]

export const GOBLINS_RUN_TERMINAL_STATUSES: readonly GoblinsRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "expired",
]

export function isGoblinsRunTerminal(status: GoblinsRunStatus): boolean {
  return GOBLINS_RUN_TERMINAL_STATUSES.includes(status)
}

// A manager function call awaiting local execution in the current segment.
export interface GoblinsRunPendingToolCall {
  callId: string
  name: string
  // Raw JSON arguments string from the function_call item.
  arguments: string
}

export interface GoblinsRunPhase {
  turn: number
  // Set right before a new background turn is created so a re-drive after a
  // crash can cancel the possibly-orphaned response instead of duplicating it.
  step?: "dispatching_turn"
  dispatchedResponseId?: string
  pendingToolCalls?: GoblinsRunPendingToolCall[]
}

export interface GoblinsRunInputMessage {
  role: "user" | "assistant"
  content: string
}

export interface GoblinsRun {
  id: string
  userId: string
  threadId: string
  assistantMessageId: string
  status: GoblinsRunStatus
  phase: GoblinsRunPhase
  openaiResponseId: string | null
  previousResponseId: string | null
  systemInstruction: string
  input: GoblinsRunInputMessage[]
  toolResults: Record<string, string>
  events: AgentStreamEvent[]
  eventCount: number
  error: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

interface StoredGoblinsRunRow {
  id: string
  userId: string
  threadId: string
  assistantMessageId: string
  status: string
  phase: unknown
  openaiResponseId: string | null
  previousResponseId: string | null
  systemInstruction: string
  input: unknown
  toolResults: unknown
  events: unknown
  eventCount: number
  error: string | null
  createdAt: Date | string
  updatedAt: Date | string
  expiresAt: Date | string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toGoblinsRun(row: StoredGoblinsRunRow): GoblinsRun {
  return {
    id: row.id,
    userId: row.userId,
    threadId: row.threadId,
    assistantMessageId: row.assistantMessageId,
    status: row.status as GoblinsRunStatus,
    phase: (row.phase ?? { turn: 0 }) as GoblinsRunPhase,
    openaiResponseId: row.openaiResponseId,
    previousResponseId: row.previousResponseId,
    systemInstruction: row.systemInstruction,
    input: (row.input ?? []) as GoblinsRunInputMessage[],
    toolResults: (row.toolResults ?? {}) as Record<string, string>,
    events: (row.events ?? []) as AgentStreamEvent[],
    eventCount: row.eventCount,
    error: row.error,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    expiresAt: toIsoString(row.expiresAt),
  }
}

const RUN_COLUMNS = sql`
  id, "userId", "threadId", "assistantMessageId", status, phase,
  "openaiResponseId", "previousResponseId", "systemInstruction", input,
  "toolResults", events, "eventCount", error, "createdAt", "updatedAt",
  "expiresAt"
`

export async function createGoblinsRun(params: {
  id: string
  userId: string
  threadId: string
  assistantMessageId: string
  systemInstruction: string
  input: GoblinsRunInputMessage[]
}): Promise<GoblinsRun> {
  const database = getDatabase()
  const result = await sql<StoredGoblinsRunRow>`
    INSERT INTO goblins_run (
      id, "userId", "threadId", "assistantMessageId", status, phase,
      "systemInstruction", input, "expiresAt"
    )
    VALUES (
      ${params.id}, ${params.userId}, ${params.threadId},
      ${params.assistantMessageId}, 'pending_dispatch',
      ${JSON.stringify({ turn: 0 })}::jsonb,
      ${params.systemInstruction}, ${JSON.stringify(params.input)}::jsonb,
      now() + (${GOBLINS_RUN_TTL_MS}::bigint * interval '1 millisecond')
    )
    RETURNING ${RUN_COLUMNS}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })

  const row = result.rows[0]
  if (!row) {
    throw new Error("Failed to create goblins run.")
  }
  return toGoblinsRun(row)
}

async function expireIfStale(run: GoblinsRun): Promise<GoblinsRun> {
  if (isGoblinsRunTerminal(run.status)) {
    return run
  }
  if (new Date(run.expiresAt).getTime() > Date.now()) {
    return run
  }
  logger.warn("Goblins run passed its TTL; marking expired.", {
    runId: run.id,
  })
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET status = 'expired', "updatedAt" = now()
    WHERE id = ${run.id}
      AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })
  return { ...run, status: "expired" }
}

export async function getGoblinsRunForUser(
  userId: string,
  runId: string
): Promise<GoblinsRun | null> {
  const database = getDatabase()
  const result = await sql<StoredGoblinsRunRow>`
    SELECT ${RUN_COLUMNS}
    FROM goblins_run
    WHERE "userId" = ${userId} AND id = ${runId}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })

  const row = result.rows[0]
  return row ? expireIfStale(toGoblinsRun(row)) : null
}

export async function getGoblinsRunByResponseId(
  responseId: string
): Promise<GoblinsRun | null> {
  const database = getDatabase()
  const result = await sql<StoredGoblinsRunRow>`
    SELECT ${RUN_COLUMNS}
    FROM goblins_run
    WHERE "openaiResponseId" = ${responseId}
       OR phase ->> 'dispatchedResponseId' = ${responseId}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })

  const row = result.rows[0]
  return row ? expireIfStale(toGoblinsRun(row)) : null
}

/**
 * Claims a run for one continuation segment. Claimable when awaiting the
 * manager, freshly dispatched, or when a previous claimant's lease expired.
 * Returns null when another invocation owns the segment — the caller must
 * exit without doing any work (this is the cross-instance webhook dedupe).
 */
export async function claimGoblinsRun(
  runId: string,
  leaseOwner: string
): Promise<GoblinsRun | null> {
  const database = getDatabase()
  const result = await sql<StoredGoblinsRunRow>`
    UPDATE goblins_run
    SET status = 'executing_tools',
        "leaseOwner" = ${leaseOwner},
        "leaseExpiresAt" = now() + (${GOBLINS_RUN_LEASE_MS}::bigint * interval '1 millisecond'),
        "updatedAt" = now()
    WHERE id = ${runId}
      AND (
        status IN ('pending_dispatch', 'awaiting_manager')
        OR (status = 'executing_tools' AND "leaseExpiresAt" < now())
      )
    RETURNING ${RUN_COLUMNS}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })

  const row = result.rows[0]
  return row ? toGoblinsRun(row) : null
}

export async function appendGoblinsRunEvents(
  runId: string,
  events: AgentStreamEvent[]
): Promise<void> {
  if (events.length === 0) {
    return
  }
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET events = events || ${JSON.stringify(events)}::jsonb,
        "eventCount" = "eventCount" + ${events.length},
        "updatedAt" = now()
    WHERE id = ${runId} AND "eventCount" < ${GOBLINS_RUN_MAX_EVENTS}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })
}

export async function recordGoblinsRunToolResult(
  runId: string,
  callId: string,
  brief: string
): Promise<void> {
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET "toolResults" = "toolResults" || ${JSON.stringify({ [callId]: brief })}::jsonb,
        "updatedAt" = now()
    WHERE id = ${runId}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })
}

export async function updateGoblinsRunPhase(
  runId: string,
  phase: GoblinsRunPhase
): Promise<void> {
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET phase = ${JSON.stringify(phase)}::jsonb, "updatedAt" = now()
    WHERE id = ${runId}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })
}

/**
 * Persists a newly dispatched background manager turn and hands the run back
 * to the webhook/poll wake sources (releases the lease).
 */
export async function advanceGoblinsRunToNextTurn(params: {
  runId: string
  openaiResponseId: string
  previousResponseId: string | null
  turn: number
}): Promise<void> {
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET status = 'awaiting_manager',
        "openaiResponseId" = ${params.openaiResponseId},
        "previousResponseId" = ${params.previousResponseId},
        phase = ${JSON.stringify({ turn: params.turn })}::jsonb,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = now()
    WHERE id = ${params.runId}
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapGoblinsRunStoreError(error)
    })
}

export async function finishGoblinsRun(
  runId: string,
  status: Extract<GoblinsRunStatus, "completed" | "failed" | "cancelled">,
  error?: string
): Promise<void> {
  const database = getDatabase()
  await sql`
    UPDATE goblins_run
    SET status = ${status},
        error = ${error ?? null},
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = now()
    WHERE id = ${runId}
      AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
  `
    .execute(database)
    .catch((wrapError: unknown) => {
      throw wrapGoblinsRunStoreError(wrapError)
    })
}
