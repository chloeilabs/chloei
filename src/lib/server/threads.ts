import { sql } from "kysely"
import { z } from "zod"

import {
  AGENT_RUN_STATUSES,
  DEFAULT_THREAD_TITLE,
  deriveThreadTitle,
  isModelType,
  type ModelType,
  normalizeThread,
  SEARCH_TOOL_NAMES,
  sortThreadsNewestFirst,
  type Thread,
  THREAD_TITLE_MAX_LENGTH,
  TOOL_NAMES,
} from "@/lib/shared"

import { getDatabase } from "./postgres"

const THREAD_STORE_SETUP_MESSAGE =
  "Thread storage is not initialized. Run `pnpm threads:migrate` to create the thread table."
const POSTGRES_UNDEFINED_TABLE_ERROR_CODE = "42P01"
const POSTGRES_UNDEFINED_COLUMN_ERROR_CODE = "42703"

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true })
const TOOL_NAME_SCHEMA = z.enum(TOOL_NAMES)
const SEARCH_TOOL_NAME_SCHEMA = z.enum(SEARCH_TOOL_NAMES)
const TOOL_INVOCATION_STATUS_SCHEMA = z.enum(["running", "success", "error"])
const AGENT_RUN_STATUS_SCHEMA = z.enum(AGENT_RUN_STATUSES)
const MODEL_TYPE_SCHEMA = z.custom<ModelType>(
  isModelType,
  "Invalid model type."
)

const messageSourceSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1).max(2048),
    title: z.string().trim().min(1).max(500),
  })
  .strict()

const toolInvocationSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    callId: z.string().trim().min(1).max(200).nullable(),
    toolName: TOOL_NAME_SCHEMA,
    label: z.string().trim().min(1).max(500),
    query: z.string().trim().min(1).max(10_000).optional(),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
  })
  .strict()

const toolActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("tool"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    callId: z.string().trim().min(1).max(200).nullable(),
    toolName: TOOL_NAME_SCHEMA,
    label: z.string().trim().min(1).max(500),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
  })
  .strict()

const searchActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("search"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    callId: z.string().trim().min(1).max(200).nullable(),
    toolName: SEARCH_TOOL_NAME_SCHEMA,
    query: z.string().trim().min(1).max(10_000),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
  })
  .strict()

const sourcesActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("sources"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    sources: z.array(messageSourceSchema),
  })
  .strict()

const reasoningActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("reasoning"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    text: z.string().max(100_000),
  })
  .strict()

const activityTimelineEntrySchema = z.union([
  toolActivityTimelineEntrySchema,
  searchActivityTimelineEntrySchema,
  sourcesActivityTimelineEntrySchema,
  reasoningActivityTimelineEntrySchema,
])

const legacyCrewStatusActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("crew_status"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    status: z.string().trim().min(1).max(100),
    crewName: z.string().trim().min(1).max(500),
  })
  .strict()

const legacyTaskProgressActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("task_progress"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    status: z.string().trim().min(1).max(100),
    taskName: z.string().trim().min(1).max(500),
    agentRole: z.string().trim().min(1).max(500),
  })
  .strict()

const legacyAgentSwitchActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("agent_switch"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    agentGoal: z.string().trim().min(1).max(10_000),
    agentRole: z.string().trim().min(1).max(500),
  })
  .strict()

const assistantMessagePartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().max(100_000),
  })
  .strict()

const messageMetadataSchema = z
  .object({
    parts: z.array(assistantMessagePartSchema).optional(),
    isStreaming: z.boolean().optional(),
    selectedModel: MODEL_TYPE_SCHEMA.optional(),
    agentStatus: AGENT_RUN_STATUS_SCHEMA.optional(),
    interactionId: z.string().trim().min(1).max(200).optional(),
    lastEventId: z.string().trim().min(1).max(500).optional(),
    toolInvocations: z.array(toolInvocationSchema).optional(),
    reasoning: z.string().max(100_000).optional(),
    activityTimeline: z.array(activityTimelineEntrySchema).optional(),
    sources: z.array(messageSourceSchema).optional(),
  })
  .strict()

const messageSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string().max(100_000),
    llmModel: z.string().trim().min(1).max(120),
    createdAt: ISO_DATETIME_SCHEMA,
    metadata: messageMetadataSchema.optional(),
  })
  .strict()

const threadSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: z.string().max(THREAD_TITLE_MAX_LENGTH),
    model: MODEL_TYPE_SCHEMA.optional(),
    isPinned: z.boolean().optional(),
    messages: z.array(messageSchema),
    createdAt: ISO_DATETIME_SCHEMA,
    updatedAt: ISO_DATETIME_SCHEMA,
  })
  .strict()

interface StoredThreadRow {
  id: string
  title: string
  model: string | null
  isPinned: boolean | null
  messages: unknown
  createdAt: Date | string
  updatedAt: Date | string
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString()
  }

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid thread timestamp.")
  }

  return parsed.toISOString()
}

function normalizeThreadForPersistence(thread: Thread): Thread {
  const normalized = normalizeThread(thread)
  const firstMessageCreatedAt = normalized.messages[0]?.createdAt
  const createdAt = firstMessageCreatedAt ?? normalized.createdAt

  return {
    ...normalized,
    title:
      normalized.title.trim() !== ""
        ? normalized.title.trim().slice(0, THREAD_TITLE_MAX_LENGTH)
        : deriveThreadTitle(normalized.messages),
    model: normalized.model ?? undefined,
    isPinned: normalized.isPinned ?? false,
    createdAt,
    updatedAt: normalized.updatedAt,
  }
}

function sanitizeModelValue(value: unknown): ModelType | undefined {
  return isModelType(value) ? value : undefined
}

function sanitizeOptionalString(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()

  if (normalized.length === 0) {
    return undefined
  }

  return normalized.slice(0, maxLength)
}

function sanitizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function sanitizeMessageSource(value: unknown) {
  const parsed = messageSourceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function sanitizeToolInvocation(value: unknown) {
  const parsed = toolInvocationSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function convertLegacyActivityTimelineEntry(value: unknown) {
  const legacyCrewStatus =
    legacyCrewStatusActivityTimelineEntrySchema.safeParse(value)
  if (legacyCrewStatus.success) {
    const { id, order, createdAt, status, crewName } = legacyCrewStatus.data
    const normalizedCrewName = crewName === "crew" ? "Crew" : crewName

    return {
      id,
      kind: "reasoning" as const,
      order,
      createdAt,
      text: `${normalizedCrewName} ${status}.`,
    }
  }

  const legacyTaskProgress =
    legacyTaskProgressActivityTimelineEntrySchema.safeParse(value)
  if (legacyTaskProgress.success) {
    const { id, order, createdAt, status, taskName, agentRole } =
      legacyTaskProgress.data

    return {
      id,
      kind: "reasoning" as const,
      order,
      createdAt,
      text: `${agentRole} ${status}: ${taskName}.`,
    }
  }

  const legacyAgentSwitch =
    legacyAgentSwitchActivityTimelineEntrySchema.safeParse(value)
  if (legacyAgentSwitch.success) {
    const { id, order, createdAt, agentGoal, agentRole } =
      legacyAgentSwitch.data

    return {
      id,
      kind: "reasoning" as const,
      order,
      createdAt,
      text: `Switched to ${agentRole}. Goal: ${agentGoal}`,
    }
  }

  return null
}

function sanitizeActivityTimelineEntry(value: unknown) {
  const parsed = activityTimelineEntrySchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }

  return convertLegacyActivityTimelineEntry(value)
}

function sanitizeMessageMetadata(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  const metadata = value as Record<string, unknown>
  const isStreaming = sanitizeOptionalBoolean(metadata.isStreaming)
  const selectedModel = sanitizeModelValue(metadata.selectedModel)
  const agentStatus = AGENT_RUN_STATUS_SCHEMA.safeParse(metadata.agentStatus)
  const interactionId = sanitizeOptionalString(metadata.interactionId, 200)
  const lastEventId = sanitizeOptionalString(metadata.lastEventId, 500)
  const reasoning = sanitizeOptionalString(metadata.reasoning, 100_000)
  const parts = Array.isArray(metadata.parts)
    ? metadata.parts.flatMap((part) => {
        const parsed = assistantMessagePartSchema.safeParse(part)
        return parsed.success ? [parsed.data] : []
      })
    : undefined
  const toolInvocations = Array.isArray(metadata.toolInvocations)
    ? metadata.toolInvocations.flatMap((invocation) => {
        const sanitized = sanitizeToolInvocation(invocation)
        return sanitized ? [sanitized] : []
      })
    : undefined
  const activityTimeline = Array.isArray(metadata.activityTimeline)
    ? metadata.activityTimeline.flatMap((entry) => {
        const sanitized = sanitizeActivityTimelineEntry(entry)
        return sanitized ? [sanitized] : []
      })
    : undefined
  const sources = Array.isArray(metadata.sources)
    ? metadata.sources.flatMap((source) => {
        const sanitized = sanitizeMessageSource(source)
        return sanitized ? [sanitized] : []
      })
    : undefined

  return {
    ...(parts ? { parts } : {}),
    ...(isStreaming !== undefined ? { isStreaming } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(agentStatus.success ? { agentStatus: agentStatus.data } : {}),
    ...(interactionId ? { interactionId } : {}),
    ...(lastEventId ? { lastEventId } : {}),
    ...(toolInvocations ? { toolInvocations } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(activityTimeline ? { activityTimeline } : {}),
    ...(sources ? { sources } : {}),
  }
}

function sanitizeThreadPayloadModels(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return payload
  }

  const thread = payload as Record<string, unknown>

  return {
    id: thread.id,
    title: thread.title,
    model: sanitizeModelValue(thread.model),
    messages: Array.isArray(thread.messages)
      ? (thread.messages as unknown[]).map((message): unknown => {
          if (
            typeof message !== "object" ||
            message === null ||
            Array.isArray(message)
          ) {
            return message
          }

          const threadMessage = message as Record<string, unknown>
          const sanitizedMetadata = sanitizeMessageMetadata(
            threadMessage.metadata
          )

          return {
            id: threadMessage.id,
            role: threadMessage.role,
            content: threadMessage.content,
            llmModel: threadMessage.llmModel,
            createdAt: threadMessage.createdAt,
            ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
          }
        })
      : thread.messages,
    isPinned: thread.isPinned,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

function parseStoredThread(row: StoredThreadRow): Thread {
  const parsed = threadSchema.parse(
    sanitizeThreadPayloadModels({
      id: row.id,
      title: row.title,
      model: row.model ?? undefined,
      isPinned: row.isPinned ?? false,
      messages: row.messages,
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
    })
  )

  return normalizeThreadForPersistence(parsed)
}

export function parseThreadPayload(payload: unknown): Thread {
  const parsed = threadSchema.parse(sanitizeThreadPayloadModels(payload))
  return normalizeThreadForPersistence(parsed)
}

class ThreadStoreNotInitializedError extends Error {
  constructor() {
    super(THREAD_STORE_SETUP_MESSAGE)
    this.name = "ThreadStoreNotInitializedError"
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

function wrapThreadStoreError(error: unknown): Error {
  if (
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_TABLE_ERROR_CODE) ||
    isPostgresErrorWithCode(error, POSTGRES_UNDEFINED_COLUMN_ERROR_CODE)
  ) {
    return new ThreadStoreNotInitializedError()
  }

  return error instanceof Error
    ? error
    : new Error("Unknown thread store error.")
}

export function isThreadStoreNotInitializedError(
  error: unknown
): error is ThreadStoreNotInitializedError {
  return error instanceof ThreadStoreNotInitializedError
}

export async function listThreadsForUser(userId: string): Promise<Thread[]> {
  const database = getDatabase()
  const result = await sql<StoredThreadRow>`
    SELECT
      id,
      title,
      model,
      "isPinned",
      messages,
      "createdAt",
      "updatedAt"
    FROM thread
    WHERE "userId" = ${userId}
    ORDER BY "updatedAt" DESC, id ASC
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapThreadStoreError(error)
    })

  const threads: Thread[] = []

  for (const row of result.rows) {
    try {
      threads.push(parseStoredThread(row))
    } catch (error) {
      console.error("Skipping invalid stored thread:", error)
    }
  }

  return sortThreadsNewestFirst(threads)
}

export async function getThreadForUser(
  userId: string,
  threadId: string
): Promise<Thread | null> {
  const database = getDatabase()
  const result = await sql<StoredThreadRow>`
    SELECT
      id,
      title,
      model,
      "isPinned",
      messages,
      "createdAt",
      "updatedAt"
    FROM thread
    WHERE "userId" = ${userId}
      AND id = ${threadId}
    LIMIT 1
  `
    .execute(database)
    .catch((error: unknown) => {
      throw wrapThreadStoreError(error)
    })

  const row = result.rows[0]
  if (!row) {
    return null
  }

  try {
    return parseStoredThread(row)
  } catch (error) {
    console.error("Skipping invalid stored thread:", error)
    return null
  }
}

export async function upsertThreadForUser(
  userId: string,
  thread: Thread
): Promise<Thread> {
  const database = getDatabase()

  const normalizedThread = normalizeThreadForPersistence(thread)
  const createdAt = normalizedThread.createdAt
  const updatedAt = normalizedThread.updatedAt
  const title =
    normalizedThread.title.trim() !== ""
      ? normalizedThread.title.trim().slice(0, THREAD_TITLE_MAX_LENGTH)
      : (normalizedThread.messages[0]?.content
          .trim()
          .slice(0, THREAD_TITLE_MAX_LENGTH) ?? DEFAULT_THREAD_TITLE)

  try {
    await sql`
      INSERT INTO thread (
        "userId",
        id,
        title,
        model,
        "isPinned",
        messages,
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${userId},
        ${normalizedThread.id},
        ${title},
        ${normalizedThread.model ?? null},
        ${normalizedThread.isPinned ?? false},
        CAST(${JSON.stringify(normalizedThread.messages)} AS jsonb),
        ${new Date(createdAt)},
        ${new Date(updatedAt)}
      )
      ON CONFLICT ("userId", id)
      DO UPDATE SET
        title = EXCLUDED.title,
        model = EXCLUDED.model,
        "isPinned" = EXCLUDED."isPinned",
        messages = EXCLUDED.messages,
        "createdAt" = LEAST(thread."createdAt", EXCLUDED."createdAt"),
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE thread."updatedAt" <= EXCLUDED."updatedAt"
    `.execute(database)
  } catch (error) {
    throw wrapThreadStoreError(error)
  }

  return {
    ...normalizedThread,
    title,
    createdAt,
    updatedAt,
    isPinned: normalizedThread.isPinned ?? false,
  }
}

export async function deleteThreadForUser(userId: string, threadId: string) {
  const database = getDatabase()

  try {
    await sql`
      DELETE FROM thread
      WHERE "userId" = ${userId}
        AND id = ${threadId}
    `.execute(database)
  } catch (error) {
    throw wrapThreadStoreError(error)
  }
}
