import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import {
  appendCloudAgentTaskEvent,
  cancelCloudAgentTaskIfActive,
  cloudAgentJsonResponse,
  createCloudAgentRouteContext,
  handleCloudAgentError,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
  resolveCloudAgentRuntimeMode,
  resolveCloudAgentSandboxAdapter,
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
    // Atomic conditional UPDATE: cancel only if the row is still in
    // one of the allowed non-terminal statuses. Prevents a TOCTOU
    // race where the background runtime transitions to `completed`
    // between a status read and a write — otherwise that update
    // would clobber the completed task's prUrl/summary.
    const task = await cancelCloudAgentTaskIfActive({
      userId: session.user.id,
      taskId,
      // `pr_ready` and `completed` are intentionally excluded: the
      // PR is already on GitHub and the Vercel webhook also stops
      // attaching previewUrl once the row goes terminal, so a late
      // cancel would silently strand the shipped PR's summary.
      allowedFromStatuses: [
        "queued",
        "provisioning",
        "setting_up",
        "planning",
        "editing",
        "testing",
        "waiting_for_approval",
        "pushing",
      ],
      phase: "Cancelled by user",
      summary: "Cancelled by user.",
    })
    // The DB row is now `cancelled` (atomic). From here on, every
    // cleanup step is best-effort: a transient event-append or
    // destroy failure must not skip the others, otherwise a retry
    // hits the transition guard and leaves the sandbox running
    // until the 90-min timeout.
    const sandboxId = task.sandboxId
    try {
      await appendCloudAgentTaskEvent({
        userId: session.user.id,
        taskId,
        payload: {
          kind: "status",
          status: "cancelled",
          phase: "Cancelled by user",
        },
      })
    } catch (error) {
      logger.warn("Failed to append cancel event after task cancelled.", {
        taskId,
        error,
      })
    }
    if (sandboxId) {
      const adapter = resolveCloudAgentSandboxAdapter(
        resolveCloudAgentRuntimeMode()
      )
      await adapter.destroy({ sandboxId }).catch((error: unknown) => {
        logger.warn("Failed to destroy sandbox on cancel.", {
          taskId,
          sandboxId,
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
