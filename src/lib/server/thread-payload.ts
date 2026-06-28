import { z } from "zod"

import {
  AGENT_RUN_STATUSES,
  DEFAULT_THREAD_TITLE,
  isModelType,
  type ModelType,
  sanitizeReasoningForDisplay,
  SEARCH_TOOL_NAMES,
  SUBAGENT_IDS,
  type Thread,
  type ThreadSummary,
  TOOL_NAMES,
  type ToolName,
} from "@/lib/shared"

// Threads saved before the Tavily→Exa migration stored the old tool names.
// Normalize them to the current Exa names on read so historical Activity
// timelines and tool invocations still validate and render.
const LEGACY_TOOL_NAME_REPLACEMENTS: Record<string, ToolName> = {
  tavily_search: "exa_search",
  tavily_extract: "exa_get_contents",
}

function remapLegacyToolName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>
  const toolName = record.toolName
  if (
    typeof toolName !== "string" ||
    !(toolName in LEGACY_TOOL_NAME_REPLACEMENTS)
  ) {
    return value
  }

  return { ...record, toolName: LEGACY_TOOL_NAME_REPLACEMENTS[toolName] }
}

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true })
const TOOL_NAME_SCHEMA = z.enum(TOOL_NAMES)
const SEARCH_TOOL_NAME_SCHEMA = z.enum(SEARCH_TOOL_NAMES)
const TOOL_INVOCATION_STATUS_SCHEMA = z.enum(["running", "success", "error"])
const SUBAGENT_ID_SCHEMA = z.enum(SUBAGENT_IDS)
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

// Persisted attachment metadata. Intentionally omits the base64 `url` (and is
// not `.strict()`) so the large data URL is stripped out when a thread is
// saved — stored threads keep only the lightweight descriptor plus the Files
// API `fileId` (so a reloaded thread can resend the file by id instead of
// losing it).
const messageAttachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["image", "pdf"]),
  name: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(200),
  fileId: z.string().trim().min(1).max(200).optional(),
})

const followUpQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(160),
  })
  .strict()
// Drop canned suggestions saved by earlier local builds when threads are
// loaded or persisted again.
const LEGACY_CANNED_FOLLOW_UP_ID_PREFIX = "fallback-follow-up"

const toolRunMetadataSchema = {
  operation: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  attempt: z.number().int().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(200).optional(),
  retryable: z.boolean().optional(),
} as const

const toolInvocationSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    callId: z.string().trim().min(1).max(200).nullable(),
    toolName: TOOL_NAME_SCHEMA,
    label: z.string().trim().min(1).max(500),
    query: z.string().trim().min(1).max(10_000).optional(),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
    ...toolRunMetadataSchema,
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
    query: z.string().trim().min(1).max(10_000).optional(),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
    ...toolRunMetadataSchema,
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
    ...toolRunMetadataSchema,
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

const subagentActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("subagent"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    callId: z.string().trim().min(1).max(200).nullable(),
    subagentId: SUBAGENT_ID_SCHEMA,
    label: z.string().trim().min(1).max(500),
    task: z.string().trim().min(1).max(10_000).optional(),
    status: TOOL_INVOCATION_STATUS_SCHEMA,
  })
  .strict()

const activityTimelineEntrySchema = z.union([
  toolActivityTimelineEntrySchema,
  searchActivityTimelineEntrySchema,
  sourcesActivityTimelineEntrySchema,
  reasoningActivityTimelineEntrySchema,
  subagentActivityTimelineEntrySchema,
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
    attachments: z.array(messageAttachmentSchema).max(10).optional(),
    followUpQuestions: z.array(followUpQuestionSchema).max(3).optional(),
    followUpQuestionsPending: z.boolean().optional(),
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
    model: MODEL_TYPE_SCHEMA.optional(),
    messages: z.array(messageSchema),
    createdAt: ISO_DATETIME_SCHEMA,
    updatedAt: ISO_DATETIME_SCHEMA,
  })
  .strict()

const threadSummarySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    model: MODEL_TYPE_SCHEMA.optional(),
    createdAt: ISO_DATETIME_SCHEMA,
    updatedAt: ISO_DATETIME_SCHEMA,
  })
  .strict()

export interface StoredThreadRow {
  id: string
  model: string | null
  messages: unknown
  createdAt: Date | string
  updatedAt: Date | string
}

export interface StoredThreadSummaryRow {
  id: string
  title: string | null
  model: string | null
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
  const firstMessageCreatedAt = thread.messages[0]?.createdAt
  const createdAt = firstMessageCreatedAt ?? thread.createdAt

  return {
    ...thread,
    model: thread.model ?? undefined,
    createdAt,
    updatedAt: thread.updatedAt,
  }
}

function sanitizeModelValue(value: unknown): ModelType | undefined {
  return isModelType(value) ? value : undefined
}

function sanitizeThreadTitle(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_THREAD_TITLE
  }

  const title = value.trim()
  return title || DEFAULT_THREAD_TITLE
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

function sanitizeMessageAttachment(value: unknown) {
  const parsed = messageAttachmentSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function sanitizeFollowUpQuestion(value: unknown) {
  const parsed = followUpQuestionSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }

  return parsed.data.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
    ? null
    : parsed.data
}

function sanitizeToolInvocation(value: unknown) {
  const parsed = toolInvocationSchema.safeParse(remapLegacyToolName(value))
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
  const remapped = remapLegacyToolName(value)
  const parsed = activityTimelineEntrySchema.safeParse(remapped)
  const entry = parsed.success
    ? parsed.data
    : convertLegacyActivityTimelineEntry(remapped)

  if (!entry) {
    return null
  }

  if (entry.kind === "reasoning") {
    const text = sanitizeOptionalString(
      sanitizeReasoningForDisplay(entry.text),
      100_000
    )
    return text ? { ...entry, text } : null
  }

  return entry
}

function sanitizeMessageMetadata(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  const metadata = value as Record<string, unknown>
  const isStreaming = sanitizeOptionalBoolean(metadata.isStreaming)
  const followUpQuestionsPending = sanitizeOptionalBoolean(
    metadata.followUpQuestionsPending
  )
  const selectedModel = sanitizeModelValue(metadata.selectedModel)
  const agentStatus = AGENT_RUN_STATUS_SCHEMA.safeParse(metadata.agentStatus)
  const interactionId = sanitizeOptionalString(metadata.interactionId, 200)
  const lastEventId = sanitizeOptionalString(metadata.lastEventId, 500)
  const reasoning =
    typeof metadata.reasoning === "string"
      ? sanitizeOptionalString(
          sanitizeReasoningForDisplay(metadata.reasoning),
          100_000
        )
      : undefined
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
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments.flatMap((attachment) => {
        const sanitized = sanitizeMessageAttachment(attachment)
        return sanitized ? [sanitized] : []
      })
    : undefined
  const followUpQuestions = Array.isArray(metadata.followUpQuestions)
    ? metadata.followUpQuestions
        .flatMap((question) => {
          const sanitized = sanitizeFollowUpQuestion(question)
          return sanitized ? [sanitized] : []
        })
        .slice(0, 3)
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
    ...(attachments?.length ? { attachments } : {}),
    ...(followUpQuestions?.length ? { followUpQuestions } : {}),
    ...(followUpQuestionsPending !== undefined
      ? { followUpQuestionsPending }
      : {}),
  }
}

function sanitizeThreadPayload(payload: unknown): unknown {
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
    model: sanitizeModelValue(thread.model),
    messages: Array.isArray(thread.messages)
      ? thread.messages.map((message): unknown => {
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
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

export function parseStoredThread(row: StoredThreadRow): Thread {
  const parsed = threadSchema.parse(
    sanitizeThreadPayload({
      id: row.id,
      model: row.model ?? undefined,
      messages: row.messages,
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
    })
  )

  return normalizeThreadForPersistence(parsed)
}

export function parseStoredThreadSummary(
  row: StoredThreadSummaryRow
): ThreadSummary {
  const parsed = threadSummarySchema.parse({
    id: row.id,
    title: sanitizeThreadTitle(row.title),
    model: sanitizeModelValue(row.model),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  })

  return {
    ...parsed,
    model: parsed.model ?? undefined,
  }
}

export function parseThreadPayload(payload: unknown): Thread {
  const parsed = threadSchema.parse(sanitizeThreadPayload(payload))
  return normalizeThreadForPersistence(parsed)
}

export function prepareThreadForPersistence(thread: Thread) {
  return normalizeThreadForPersistence(thread)
}
