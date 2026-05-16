import { createLogger } from "@/lib/logger"
import type { CloudAgentEvent } from "@/lib/shared/cloud-agents"

import { appendCloudAgentTaskEvent } from "./events"
import { type CloudAgentTaskUpdate, updateCloudAgentTask } from "./tasks"

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
  await applyCloudAgentStatus({
    userId: params.userId,
    taskId: params.taskId,
    update: { status: "failed", error: message },
  })
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
