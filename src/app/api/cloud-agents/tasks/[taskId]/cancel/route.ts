import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import {
  appendCloudAgentTaskEvent,
  cloudAgentJsonResponse,
  createCloudAgentRouteContext,
  handleCloudAgentError,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
  requireCloudAgentTaskTransition,
  resolveCloudAgentRuntimeMode,
  resolveCloudAgentSandboxAdapter,
  updateCloudAgentTask,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

const logger = createLogger("cloud-agent-cancel")

interface RouteContext {
  params: Promise<{ taskId: string }>
}

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "POST",
    route: "/api/cloud-agents/tasks/[taskId]/cancel",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { taskId } = await routeContext.params
    const priorTask = await requireCloudAgentTaskTransition({
      userId: session.user.id,
      taskId,
      from: [
        "queued",
        "provisioning",
        "setting_up",
        "planning",
        "editing",
        "testing",
        "waiting_for_approval",
        "pushing",
        "pr_ready",
      ],
    })
    const task = await updateCloudAgentTask(session.user.id, taskId, {
      status: "cancelled",
      phase: "Cancelled by user",
      summary: "Cancelled by user.",
    })
    await appendCloudAgentTaskEvent({
      userId: session.user.id,
      taskId,
      payload: {
        kind: "status",
        status: "cancelled",
        phase: "Cancelled by user",
      },
    })
    if (priorTask.sandboxId) {
      const adapter = resolveCloudAgentSandboxAdapter(
        resolveCloudAgentRuntimeMode()
      )
      await adapter
        .destroy({ sandboxId: priorTask.sandboxId })
        .catch((error: unknown) => {
          logger.warn("Failed to destroy sandbox on cancel.", {
            taskId,
            sandboxId: priorTask.sandboxId,
            error,
          })
        })
    }
    return cloudAgentJsonResponse(context, { task })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to cancel cloud agent task.",
      errorCode: "CLOUD_AGENT_TASK_CANCEL_FAILED",
    })
  }
}
