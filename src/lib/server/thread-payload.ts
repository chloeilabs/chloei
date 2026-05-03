import { Buffer } from "node:buffer"

import { z } from "zod"

import {
  AGENT_ATTACHMENT_MAX_FILE_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  AGENT_ATTACHMENT_MAX_TOTAL_PREVIEW_BYTES,
  AGENT_ATTACHMENT_MIME_TYPES,
  AGENT_IMAGE_DETAIL_VALUES,
  AGENT_RUN_MODES,
  AGENT_RUN_STATUSES,
  type AgentRunMode,
  getAgentAttachmentKind,
  isAgentAttachmentPreviewDataUrl,
  isModelType,
  type ModelType,
  normalizeAgentAttachmentMimeType,
  SEARCH_TOOL_NAMES,
  type Thread,
  TOOL_NAMES,
} from "@/lib/shared"

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true })
const TOOL_NAME_SCHEMA = z.enum(TOOL_NAMES)
const SEARCH_TOOL_NAME_SCHEMA = z.enum(SEARCH_TOOL_NAMES)
const TOOL_INVOCATION_STATUS_SCHEMA = z.enum(["running", "success", "error"])
const AGENT_RUN_STATUS_SCHEMA = z.enum(AGENT_RUN_STATUSES)
const AGENT_RUN_MODE_SCHEMA = z.enum(AGENT_RUN_MODES)
const AGENT_IMAGE_DETAIL_SCHEMA = z.enum(AGENT_IMAGE_DETAIL_VALUES)
const MODEL_TYPE_SCHEMA = z.custom<ModelType>(
  isModelType,
  "Invalid model type."
)
const AGENT_ATTACHMENT_MIME_TYPE_SCHEMA = z.enum(AGENT_ATTACHMENT_MIME_TYPES)

const messageSourceSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1).max(2048),
    title: z.string().trim().min(1).max(500),
  })
  .strict()

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

const harnessActivityTimelineEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("harness"),
    order: z.number().int().nonnegative(),
    createdAt: ISO_DATETIME_SCHEMA,
    label: z.string().trim().min(1).max(500),
    status: z.union([
      TOOL_INVOCATION_STATUS_SCHEMA,
      z.literal("info"),
      z.literal("warning"),
    ]),
    detail: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict()

const activityTimelineEntrySchema = z.union([
  toolActivityTimelineEntrySchema,
  searchActivityTimelineEntrySchema,
  sourcesActivityTimelineEntrySchema,
  reasoningActivityTimelineEntrySchema,
  harnessActivityTimelineEntrySchema,
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

const attachmentMetadataSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["image", "pdf"]),
    filename: z.string().trim().min(1).max(500),
    mediaType: AGENT_ATTACHMENT_MIME_TYPE_SCHEMA,
    sizeBytes: z.number().int().positive().max(AGENT_ATTACHMENT_MAX_FILE_BYTES),
    detail: AGENT_IMAGE_DETAIL_SCHEMA.optional(),
    previewDataUrl: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS)
      .refine(isAgentAttachmentPreviewDataUrl, {
        message: "Attachment preview must be a supported image data URL.",
      })
      .optional(),
  })
  .strict()
  .refine(
    (attachment) =>
      attachment.kind === getAgentAttachmentKind(attachment.mediaType),
    {
      message: "Attachment kind must match media type.",
    }
  )
  .refine((attachment) => attachment.kind === "image" || !attachment.detail, {
    message: "Only image attachments can include detail.",
  })

function getAttachmentPreviewBytes(
  attachment: z.infer<typeof attachmentMetadataSchema>
): number {
  return attachment.previewDataUrl
    ? Buffer.byteLength(attachment.previewDataUrl, "utf8")
    : 0
}

const attachmentMetadataListSchema = z
  .array(attachmentMetadataSchema)
  .max(AGENT_ATTACHMENT_MAX_FILES)
  .refine(
    (attachments) =>
      attachments.reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0
      ) <= AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
    {
      message: "Attachment metadata exceeds total size limit.",
    }
  )
  .refine(
    (attachments) =>
      attachments.reduce(
        (total, attachment) => total + getAttachmentPreviewBytes(attachment),
        0
      ) <= AGENT_ATTACHMENT_MAX_TOTAL_PREVIEW_BYTES,
    {
      message: "Attachment previews exceed total preview size limit.",
    }
  )

const messageMetadataSchema = z
  .object({
    parts: z.array(assistantMessagePartSchema).optional(),
    attachments: attachmentMetadataListSchema.optional(),
    isStreaming: z.boolean().optional(),
    selectedModel: MODEL_TYPE_SCHEMA.optional(),
    runMode: AGENT_RUN_MODE_SCHEMA.optional(),
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
    model: MODEL_TYPE_SCHEMA.optional(),
    messages: z.array(messageSchema),
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

function sanitizeRunModeValue(value: unknown): AgentRunMode | undefined {
  const parsed = AGENT_RUN_MODE_SCHEMA.safeParse(value)
  return parsed.success ? parsed.data : undefined
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

function sanitizeAttachmentMetadata(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }

  const attachment = value as Record<string, unknown>
  const mediaType = normalizeAgentAttachmentMimeType(attachment.mediaType)
  if (!mediaType) {
    return null
  }

  const candidatePreviewDataUrl = attachment.previewDataUrl
  const previewDataUrl = isAgentAttachmentPreviewDataUrl(
    candidatePreviewDataUrl
  )
    ? candidatePreviewDataUrl.trim()
    : undefined

  const parsed = attachmentMetadataSchema.safeParse({
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mediaType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.detail !== undefined ? { detail: attachment.detail } : {}),
    ...(previewDataUrl ? { previewDataUrl } : {}),
  })

  if (!parsed.success) {
    return null
  }

  return parsed.data
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
  const runMode = sanitizeRunModeValue(metadata.runMode)
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
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments.flatMap((attachment) => {
        const sanitized = sanitizeAttachmentMetadata(attachment)
        return sanitized ? [sanitized] : []
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
    ...(attachments ? { attachments } : {}),
    ...(isStreaming !== undefined ? { isStreaming } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(runMode !== undefined ? { runMode } : {}),
    ...(agentStatus.success ? { agentStatus: agentStatus.data } : {}),
    ...(interactionId ? { interactionId } : {}),
    ...(lastEventId ? { lastEventId } : {}),
    ...(toolInvocations ? { toolInvocations } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(activityTimeline ? { activityTimeline } : {}),
    ...(sources ? { sources } : {}),
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

export function parseThreadPayload(payload: unknown): Thread {
  const parsed = threadSchema.parse(sanitizeThreadPayload(payload))
  return normalizeThreadForPersistence(parsed)
}

export function prepareThreadForPersistence(thread: Thread) {
  return normalizeThreadForPersistence(thread)
}
