export const CLOUD_AGENT_TASK_STATUSES = [
  "queued",
  "provisioning",
  "setting_up",
  "planning",
  "editing",
  "testing",
  "waiting_for_approval",
  "pushing",
  "pr_ready",
  "completed",
  "failed",
  "cancelled",
] as const

export type CloudAgentTaskStatus = (typeof CLOUD_AGENT_TASK_STATUSES)[number]

const CLOUD_AGENT_TERMINAL_STATUSES = new Set<CloudAgentTaskStatus>([
  "completed",
  "failed",
  "cancelled",
])

const CLOUD_AGENT_IN_PROGRESS_STATUSES = new Set<CloudAgentTaskStatus>([
  "queued",
  "provisioning",
  "setting_up",
  "planning",
  "editing",
  "testing",
  "pushing",
])

// Statuses the cancel API will accept. `pr_ready` and `completed`
// are intentionally excluded: the PR is already shipped and a late
// cancel would clobber the summary and break the Vercel preview
// attachment. UI and server share this set so the cancel button is
// only shown when the request will actually succeed.
export const CLOUD_AGENT_CANCELABLE_STATUSES = [
  "queued",
  "provisioning",
  "setting_up",
  "planning",
  "editing",
  "testing",
  "waiting_for_approval",
  "pushing",
] as const satisfies readonly CloudAgentTaskStatus[]
const CLOUD_AGENT_CANCELABLE_STATUS_SET = new Set<CloudAgentTaskStatus>(
  CLOUD_AGENT_CANCELABLE_STATUSES
)

export function isCancelableCloudAgentTaskStatus(
  status: CloudAgentTaskStatus
): boolean {
  return CLOUD_AGENT_CANCELABLE_STATUS_SET.has(status)
}

export function isTerminalCloudAgentTaskStatus(
  status: CloudAgentTaskStatus
): boolean {
  return CLOUD_AGENT_TERMINAL_STATUSES.has(status)
}

export function isInProgressCloudAgentTaskStatus(
  status: CloudAgentTaskStatus
): boolean {
  return CLOUD_AGENT_IN_PROGRESS_STATUSES.has(status)
}

export function isCloudAgentTaskStatus(
  value: unknown
): value is CloudAgentTaskStatus {
  return (
    typeof value === "string" &&
    (CLOUD_AGENT_TASK_STATUSES as readonly string[]).includes(value)
  )
}

export const CLOUD_AGENT_APPROVAL_ACTIONS = [
  "push_branch",
  "create_pr",
  "deploy_preview",
  "deploy_production",
  "use_secret",
  "run_sensitive_command",
] as const

export type CloudAgentApprovalAction =
  (typeof CLOUD_AGENT_APPROVAL_ACTIONS)[number]

export function isCloudAgentApprovalAction(
  value: unknown
): value is CloudAgentApprovalAction {
  return (
    typeof value === "string" &&
    (CLOUD_AGENT_APPROVAL_ACTIONS as readonly string[]).includes(value)
  )
}

export const CLOUD_AGENT_EVENT_KINDS = [
  "status",
  "text_delta",
  "tool_call",
  "tool_result",
  "terminal_output",
  "file_change",
  "diff_update",
  "artifact",
  "approval_required",
  "preview_ready",
  "error",
] as const

export type CloudAgentEventKind = (typeof CLOUD_AGENT_EVENT_KINDS)[number]

export interface CloudAgentStatusEvent {
  kind: "status"
  status: CloudAgentTaskStatus
  phase?: string
}

export interface CloudAgentTextDeltaEvent {
  kind: "text_delta"
  text: string
}

export interface CloudAgentToolCallEvent {
  kind: "tool_call"
  callId: string
  toolName: string
  label: string
  query?: string
  input?: unknown
}

export interface CloudAgentToolResultEvent {
  kind: "tool_result"
  callId: string
  status: "success" | "error"
  output?: unknown
  error?: string
}

export interface CloudAgentTerminalOutputEvent {
  kind: "terminal_output"
  stream: "stdout" | "stderr"
  chunk: string
  callId?: string
}

export type CloudAgentFileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"

export interface CloudAgentFileChangeEvent {
  kind: "file_change"
  path: string
  change: CloudAgentFileChangeKind
  previousPath?: string
}

export interface CloudAgentDiffUpdateEvent {
  kind: "diff_update"
  filesChanged: number
  additions: number
  deletions: number
}

export interface CloudAgentArtifactEvent {
  kind: "artifact"
  artifactId: string
}

export interface CloudAgentApprovalRequiredEvent {
  kind: "approval_required"
  approvalId: string
  action: CloudAgentApprovalAction
  reason: string
}

export interface CloudAgentPreviewReadyEvent {
  kind: "preview_ready"
  url: string
  environment?: string
}

export interface CloudAgentErrorEvent {
  kind: "error"
  message: string
  errorCode?: string
  retryable?: boolean
}

export type CloudAgentEvent =
  | CloudAgentStatusEvent
  | CloudAgentTextDeltaEvent
  | CloudAgentToolCallEvent
  | CloudAgentToolResultEvent
  | CloudAgentTerminalOutputEvent
  | CloudAgentFileChangeEvent
  | CloudAgentDiffUpdateEvent
  | CloudAgentArtifactEvent
  | CloudAgentApprovalRequiredEvent
  | CloudAgentPreviewReadyEvent
  | CloudAgentErrorEvent

export const CLOUD_AGENT_NETWORK_POLICY_MODES = [
  "setup_only",
  "open",
  "off",
  "allowlist",
] as const

export type CloudAgentNetworkPolicyMode =
  (typeof CLOUD_AGENT_NETWORK_POLICY_MODES)[number]

export interface CloudAgentNetworkPolicy {
  mode: CloudAgentNetworkPolicyMode
  allowlist?: string[]
}

// Mirror the runtimes the @vercel/sandbox SDK actually accepts so a
// user-selected value lands the version they expect. (Previously we
// exposed "python311"/"python312" and silently downgraded to 3.13.)
export const CLOUD_AGENT_SANDBOX_RUNTIMES = [
  "node22",
  "node24",
  "node26",
  "python313",
] as const

export type CloudAgentSandboxRuntime =
  (typeof CLOUD_AGENT_SANDBOX_RUNTIMES)[number]

export const CLOUD_AGENT_REPO_PROVIDERS = ["github"] as const
export type CloudAgentRepoProvider = (typeof CLOUD_AGENT_REPO_PROVIDERS)[number]

export interface CloudAgentEnvironment {
  id: string
  name: string
  repoProvider: CloudAgentRepoProvider
  repoOwner: string
  repoName: string
  baseBranch: string
  setupCommand?: string
  testCommand?: string
  devCommand?: string
  networkPolicy: CloudAgentNetworkPolicy
  vercelProjectId?: string
  sandboxRuntime: CloudAgentSandboxRuntime
  createdAt: string
  updatedAt: string
}

export interface CloudAgentTask {
  id: string
  environmentId: string
  prompt: string
  status: CloudAgentTaskStatus
  phase?: string
  branch?: string
  sandboxId?: string
  snapshotId?: string
  prUrl?: string
  previewUrl?: string
  summary?: string
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface CloudAgentTaskEvent {
  id: string
  taskId: string
  seq: number
  payload: CloudAgentEvent
  createdAt: string
}

export const CLOUD_AGENT_ARTIFACT_KINDS = [
  "screenshot",
  "log",
  "video",
  "coverage",
  "file",
  "preview",
  "other",
] as const

export type CloudAgentArtifactKind = (typeof CLOUD_AGENT_ARTIFACT_KINDS)[number]

export interface CloudAgentArtifact {
  id: string
  taskId: string
  kind: CloudAgentArtifactKind
  label: string
  mediaType?: string
  sizeBytes?: number
  url?: string
  blobPathname?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export function getCloudAgentDefaultNetworkPolicy(): CloudAgentNetworkPolicy {
  return { mode: "setup_only" }
}

export function deriveCloudAgentTaskBranchName(params: {
  taskId: string
  slug?: string
}): string {
  const slug = (params.slug ?? "task")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  const shortId = params.taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  return `chloei/${slug || "task"}-${shortId}`
}
