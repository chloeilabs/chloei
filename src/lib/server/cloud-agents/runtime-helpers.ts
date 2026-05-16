import { createLogger } from "@/lib/logger"
import type {
  CloudAgentEnvironment,
  CloudAgentEvent,
  CloudAgentTask,
  CloudAgentTaskStatus,
} from "@/lib/shared/cloud-agents"

import { getCloudAgentEnvironment } from "./environments"
import { appendCloudAgentTaskEvent } from "./events"
import {
  type CloudAgentTaskUpdate,
  updateCloudAgentTask,
  updateCloudAgentTaskIfStatusIn,
} from "./tasks"

export const TERMINAL_CHUNK_MAX_CHARS = 11_800

export function clampTerminalChunk(value: string): string {
  if (value.length <= TERMINAL_CHUNK_MAX_CHARS) {
    return value
  }
  return `${value.slice(0, TERMINAL_CHUNK_MAX_CHARS)}\n…[truncated ${String(value.length - TERMINAL_CHUNK_MAX_CHARS)} chars]`
}

export async function emitCloudAgentEvent(params: {
  userId: string
  taskId: string
  event: CloudAgentEvent
}): Promise<void> {
  await appendCloudAgentTaskEvent({
    userId: params.userId,
    taskId: params.taskId,
    payload: params.event,
  })
}

// Emit stdout and stderr as separate events. Combining them with
// `stdout || stderr` would drop one stream entirely and could mislabel
// stdout chunks as stderr on failures; commands that write to both
// streams need both visible in the activity timeline.
export async function emitTerminalOutput(params: {
  userId: string
  taskId: string
  stdout: string
  stderr: string
  callId?: string
}): Promise<void> {
  if (params.stdout) {
    await emitCloudAgentEvent({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "terminal_output",
        stream: "stdout",
        chunk: clampTerminalChunk(params.stdout),
        ...(params.callId ? { callId: params.callId } : {}),
      },
    })
  }
  if (params.stderr) {
    await emitCloudAgentEvent({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "terminal_output",
        stream: "stderr",
        chunk: clampTerminalChunk(params.stderr),
        ...(params.callId ? { callId: params.callId } : {}),
      },
    })
  }
}

export async function applyCloudAgentStatus(params: {
  userId: string
  taskId: string
  update: CloudAgentTaskUpdate
  phase?: string
}): Promise<void> {
  await updateCloudAgentTask(params.userId, params.taskId, {
    ...params.update,
    ...(params.phase !== undefined ? { phase: params.phase } : {}),
  })
  if (params.update.status) {
    await emitCloudAgentEvent({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "status",
        status: params.update.status,
        ...(params.phase ? { phase: params.phase } : {}),
      },
    })
  }
}

// Conditional sibling of applyCloudAgentStatus: writes only if the
// row's current status is in `allowedFromStatuses`, and emits the
// status event only when the write actually landed. Returns the
// updated task, or null if a concurrent transition (e.g. user
// cancel mid-push) moved the row out of the allowed set. Push-flow
// callers use this so completion of a shipped PR can't silently
// overwrite a user cancel.
export async function applyCloudAgentStatusIfFrom(params: {
  userId: string
  taskId: string
  allowedFromStatuses: CloudAgentTaskStatus[]
  update: CloudAgentTaskUpdate
  phase?: string
}): Promise<CloudAgentTask | null> {
  const updated = await updateCloudAgentTaskIfStatusIn({
    userId: params.userId,
    taskId: params.taskId,
    allowedFromStatuses: params.allowedFromStatuses,
    update: {
      ...params.update,
      ...(params.phase !== undefined ? { phase: params.phase } : {}),
    },
  })
  if (!updated) return null
  if (params.update.status) {
    await emitCloudAgentEvent({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "status",
        status: params.update.status,
        ...(params.phase ? { phase: params.phase } : {}),
      },
    })
  }
  return updated
}

// Shared environment-lookup guard used by both scripted and LLM
// runtimes. On miss, marks the task `failed` and emits an `error`
// event before returning null so callers can early-return.
export async function getCloudAgentEnvironmentOrFail(params: {
  userId: string
  taskId: string
  environmentId: string
}): Promise<CloudAgentEnvironment | null> {
  const environment = await getCloudAgentEnvironment(
    params.userId,
    params.environmentId
  )
  if (environment) return environment
  await applyCloudAgentStatus({
    userId: params.userId,
    taskId: params.taskId,
    update: { status: "failed", error: "Environment not found." },
  })
  await emitCloudAgentEvent({
    userId: params.userId,
    taskId: params.taskId,
    event: {
      kind: "error",
      message: "Environment not found for this task.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_MISSING",
      retryable: false,
    },
  })
  return null
}

// Non-terminal statuses — the runtime fail path is only allowed to
// flip the row when it's still in one of these. Prevents a runtime
// error after a user `cancel` (or another path's `completed`) from
// silently rewriting the terminal state to `failed`.
const NON_TERMINAL_TASK_STATUSES: CloudAgentTaskStatus[] = [
  "queued",
  "provisioning",
  "setting_up",
  "planning",
  "editing",
  "testing",
  "waiting_for_approval",
  "pushing",
  "pr_ready",
]

export async function failCloudAgentTask(params: {
  userId: string
  taskId: string
  error: unknown
  errorCode?: string
  loggerScope?: string
}): Promise<void> {
  const message =
    params.error instanceof Error
      ? params.error.message
      : "Unknown cloud agent failure."
  const logger = createLogger(params.loggerScope ?? "cloud-agent-runtime")
  logger.error("Cloud agent task run failed.", {
    userId: params.userId,
    taskId: params.taskId,
    error: params.error,
  })
  const updated = await applyCloudAgentStatusIfFrom({
    userId: params.userId,
    taskId: params.taskId,
    allowedFromStatuses: NON_TERMINAL_TASK_STATUSES,
    update: { status: "failed", error: message },
  })
  // Only emit the error event when the status transition actually
  // landed. Otherwise the row is already in a terminal state set by
  // someone else (user cancel, push completion, etc.) and a stray
  // error event would pollute the timeline of a closed task.
  if (!updated) {
    logger.info(
      "Skipping fail: task already in terminal state, leaving as-is.",
      { userId: params.userId, taskId: params.taskId }
    )
    return
  }
  await emitCloudAgentEvent({
    userId: params.userId,
    taskId: params.taskId,
    event: {
      kind: "error",
      message,
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
      retryable: false,
    },
  })
}
