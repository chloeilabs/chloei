import { z } from "zod"

import {
  CLOUD_AGENT_APPROVAL_ACTIONS,
  CLOUD_AGENT_ARTIFACT_KINDS,
  CLOUD_AGENT_NETWORK_POLICY_MODES,
  CLOUD_AGENT_REPO_PROVIDERS,
  CLOUD_AGENT_SANDBOX_RUNTIMES,
  CLOUD_AGENT_TASK_STATUSES,
  type CloudAgentArtifact,
  type CloudAgentEnvironment,
  type CloudAgentTask,
  type CloudAgentTaskEvent,
} from "@/lib/shared/cloud-agents"

const ID_SCHEMA = z.string().trim().min(1).max(200)
const SHORT_TEXT_SCHEMA = z.string().trim().min(1).max(200)
const COMMAND_SCHEMA = z.string().trim().min(1).max(2_000)
const PROMPT_SCHEMA = z.string().trim().min(1).max(20_000)
const URL_SCHEMA = z.string().trim().min(1).max(2_048)
const PATH_SCHEMA = z.string().trim().min(1).max(1_000)

// GitHub repo owner/name and git branch names land in shell commands
// downstream (the Vercel adapter's git push). Even though those commands
// now pass these through env vars (which the shell does not re-parse),
// constrain the character set at the API boundary as defense in depth.
// GitHub allows alphanumerics + hyphen / underscore / dot in
// owners and names. Branch names additionally allow `/`.
const REPO_IDENTIFIER_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Must contain only letters, digits, '.', '_', '-'."
  )
const GIT_REF_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._/-]+$/,
    "Must contain only letters, digits, '.', '_', '-', '/'."
  )

const NETWORK_POLICY_SCHEMA = z
  .object({
    mode: z.enum(CLOUD_AGENT_NETWORK_POLICY_MODES),
    allowlist: z.array(z.string().trim().min(1).max(255)).max(64).optional(),
  })
  .strict()

const ENVIRONMENT_BASE_FIELDS = {
  name: SHORT_TEXT_SCHEMA,
  repoProvider: z.enum(CLOUD_AGENT_REPO_PROVIDERS).default("github"),
  repoOwner: REPO_IDENTIFIER_SCHEMA,
  repoName: REPO_IDENTIFIER_SCHEMA,
  baseBranch: GIT_REF_SCHEMA.default("main"),
  setupCommand: COMMAND_SCHEMA.optional(),
  testCommand: COMMAND_SCHEMA.optional(),
  devCommand: COMMAND_SCHEMA.optional(),
  networkPolicy: NETWORK_POLICY_SCHEMA.default({ mode: "setup_only" }),
  vercelProjectId: SHORT_TEXT_SCHEMA.optional(),
  sandboxRuntime: z.enum(CLOUD_AGENT_SANDBOX_RUNTIMES).default("node22"),
}

export const cloudAgentEnvironmentCreateSchema = z
  .object(ENVIRONMENT_BASE_FIELDS)
  .strict()

export const cloudAgentEnvironmentUpdateSchema = z
  .object({
    name: SHORT_TEXT_SCHEMA.optional(),
    baseBranch: GIT_REF_SCHEMA.optional(),
    setupCommand: COMMAND_SCHEMA.nullish(),
    testCommand: COMMAND_SCHEMA.nullish(),
    devCommand: COMMAND_SCHEMA.nullish(),
    networkPolicy: NETWORK_POLICY_SCHEMA.optional(),
    vercelProjectId: SHORT_TEXT_SCHEMA.nullish(),
    sandboxRuntime: z.enum(CLOUD_AGENT_SANDBOX_RUNTIMES).optional(),
  })
  .strict()

export const cloudAgentTaskCreateSchema = z
  .object({
    environmentId: ID_SCHEMA,
    prompt: PROMPT_SCHEMA,
  })
  .strict()

export const cloudAgentTaskMessageSchema = z
  .object({
    message: PROMPT_SCHEMA,
  })
  .strict()

export const cloudAgentTaskApproveSchema = z
  .object({
    approvalId: ID_SCHEMA,
    decision: z.enum(["approve", "deny"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict()

const STATUS_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("status"),
    status: z.enum(CLOUD_AGENT_TASK_STATUSES),
    phase: SHORT_TEXT_SCHEMA.optional(),
  })
  .strict()

const TEXT_DELTA_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("text_delta"),
    text: z.string().max(20_000),
  })
  .strict()

const TOOL_CALL_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("tool_call"),
    callId: ID_SCHEMA,
    toolName: SHORT_TEXT_SCHEMA,
    label: SHORT_TEXT_SCHEMA,
    query: z.string().trim().min(1).max(2_000).optional(),
    input: z.unknown().optional(),
  })
  .strict()

const TOOL_RESULT_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("tool_result"),
    callId: ID_SCHEMA,
    status: z.enum(["success", "error"]),
    output: z.unknown().optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict()

const TERMINAL_OUTPUT_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("terminal_output"),
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string().max(12_000),
    callId: ID_SCHEMA.optional(),
  })
  .strict()

const FILE_CHANGE_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("file_change"),
    path: PATH_SCHEMA,
    change: z.enum(["added", "modified", "deleted", "renamed"]),
    previousPath: PATH_SCHEMA.optional(),
  })
  .strict()

const DIFF_UPDATE_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("diff_update"),
    filesChanged: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict()

const ARTIFACT_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("artifact"),
    artifactId: ID_SCHEMA,
  })
  .strict()

const APPROVAL_REQUIRED_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("approval_required"),
    approvalId: ID_SCHEMA,
    action: z.enum(CLOUD_AGENT_APPROVAL_ACTIONS),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()

const PREVIEW_READY_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("preview_ready"),
    url: URL_SCHEMA,
    environment: SHORT_TEXT_SCHEMA.optional(),
  })
  .strict()

const ERROR_EVENT_PAYLOAD = z
  .object({
    kind: z.literal("error"),
    message: z.string().trim().min(1).max(2_000),
    errorCode: SHORT_TEXT_SCHEMA.optional(),
    retryable: z.boolean().optional(),
  })
  .strict()

export const cloudAgentEventPayloadSchema = z.discriminatedUnion("kind", [
  STATUS_EVENT_PAYLOAD,
  TEXT_DELTA_EVENT_PAYLOAD,
  TOOL_CALL_EVENT_PAYLOAD,
  TOOL_RESULT_EVENT_PAYLOAD,
  TERMINAL_OUTPUT_EVENT_PAYLOAD,
  FILE_CHANGE_EVENT_PAYLOAD,
  DIFF_UPDATE_EVENT_PAYLOAD,
  ARTIFACT_EVENT_PAYLOAD,
  APPROVAL_REQUIRED_EVENT_PAYLOAD,
  PREVIEW_READY_EVENT_PAYLOAD,
  ERROR_EVENT_PAYLOAD,
])

export const cloudAgentArtifactCreateSchema = z
  .object({
    kind: z.enum(CLOUD_AGENT_ARTIFACT_KINDS),
    label: SHORT_TEXT_SCHEMA,
    mediaType: z.string().trim().min(1).max(200).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    url: URL_SCHEMA.optional(),
    blobPathname: PATH_SCHEMA.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

export type CloudAgentEnvironmentCreateInput = z.infer<
  typeof cloudAgentEnvironmentCreateSchema
>
export type CloudAgentEnvironmentUpdateInput = z.infer<
  typeof cloudAgentEnvironmentUpdateSchema
>
export type CloudAgentTaskCreateInput = z.infer<
  typeof cloudAgentTaskCreateSchema
>
export type CloudAgentTaskApproveInput = z.infer<
  typeof cloudAgentTaskApproveSchema
>
export type CloudAgentTaskMessageInput = z.infer<
  typeof cloudAgentTaskMessageSchema
>
export type CloudAgentArtifactCreateInput = z.infer<
  typeof cloudAgentArtifactCreateSchema
>

function toIsoString(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid cloud agent timestamp.")
  }
  return parsed.toISOString()
}

export interface CloudAgentEnvironmentRow {
  id: string
  name: string
  repoProvider: string
  repoOwner: string
  repoName: string
  baseBranch: string
  setupCommand: string | null
  testCommand: string | null
  devCommand: string | null
  networkPolicy: unknown
  vercelProjectId: string | null
  sandboxRuntime: string
  createdAt: Date | string
  updatedAt: Date | string
}

export function parseEnvironmentRow(
  row: CloudAgentEnvironmentRow
): CloudAgentEnvironment {
  const policy = NETWORK_POLICY_SCHEMA.safeParse(row.networkPolicy)
  return {
    id: row.id,
    name: row.name,
    repoProvider: z
      .enum(CLOUD_AGENT_REPO_PROVIDERS)
      .catch("github")
      .parse(row.repoProvider),
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    baseBranch: row.baseBranch,
    ...(row.setupCommand ? { setupCommand: row.setupCommand } : {}),
    ...(row.testCommand ? { testCommand: row.testCommand } : {}),
    ...(row.devCommand ? { devCommand: row.devCommand } : {}),
    networkPolicy: policy.success ? policy.data : { mode: "setup_only" },
    ...(row.vercelProjectId ? { vercelProjectId: row.vercelProjectId } : {}),
    sandboxRuntime: z
      .enum(CLOUD_AGENT_SANDBOX_RUNTIMES)
      .catch("node22")
      .parse(row.sandboxRuntime),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}

export interface CloudAgentTaskRow {
  id: string
  environmentId: string
  prompt: string
  status: string
  phase: string | null
  branch: string | null
  sandboxId: string | null
  snapshotId: string | null
  prUrl: string | null
  previewUrl: string | null
  summary: string | null
  error: string | null
  createdAt: Date | string
  updatedAt: Date | string
  completedAt: Date | string | null
}

export function parseTaskRow(row: CloudAgentTaskRow): CloudAgentTask {
  const status = z
    .enum(CLOUD_AGENT_TASK_STATUSES)
    .catch("failed")
    .parse(row.status)
  return {
    id: row.id,
    environmentId: row.environmentId,
    prompt: row.prompt,
    status,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.sandboxId ? { sandboxId: row.sandboxId } : {}),
    ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}),
    ...(row.prUrl ? { prUrl: row.prUrl } : {}),
    ...(row.previewUrl ? { previewUrl: row.previewUrl } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    ...(row.completedAt ? { completedAt: toIsoString(row.completedAt) } : {}),
  }
}

export interface CloudAgentTaskEventRow {
  id: string
  taskId: string
  seq: string | number | bigint
  payload: unknown
  createdAt: Date | string
}

export function parseTaskEventRow(
  row: CloudAgentTaskEventRow
): CloudAgentTaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    seq: Number(row.seq),
    payload: cloudAgentEventPayloadSchema.parse(row.payload),
    createdAt: toIsoString(row.createdAt),
  }
}

export interface CloudAgentArtifactRow {
  id: string
  taskId: string
  kind: string
  label: string
  mediaType: string | null
  sizeBytes: string | number | bigint | null
  url: string | null
  blobPathname: string | null
  metadata: unknown
  createdAt: Date | string
}

export function parseArtifactRow(
  row: CloudAgentArtifactRow
): CloudAgentArtifact {
  const kind = z.enum(CLOUD_AGENT_ARTIFACT_KINDS).catch("other").parse(row.kind)
  const metadata =
    row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  return {
    id: row.id,
    taskId: row.taskId,
    kind,
    label: row.label,
    ...(row.mediaType ? { mediaType: row.mediaType } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: Number(row.sizeBytes) } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.blobPathname ? { blobPathname: row.blobPathname } : {}),
    metadata,
    createdAt: toIsoString(row.createdAt),
  }
}
