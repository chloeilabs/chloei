import { type NextRequest } from "next/server"

import {
  appendCloudAgentTaskEvent,
  cloudAgentJsonResponse,
  CloudAgentNotFoundError,
  cloudAgentTaskMessageSchema,
  createCloudAgentRouteContext,
  getCloudAgentTask,
  handleCloudAgentError,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

interface RouteContext {
  params: Promise<{ taskId: string }>
}

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "POST",
    route: "/api/cloud-agents/tasks/[taskId]/message",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { taskId } = await routeContext.params
    const payload: unknown = await request.json()
    const input = cloudAgentTaskMessageSchema.parse(payload)
    const task = await getCloudAgentTask(session.user.id, taskId)
    if (!task) {
      throw new CloudAgentNotFoundError("task", taskId)
    }
    const event = await appendCloudAgentTaskEvent({
      userId: session.user.id,
      taskId,
      payload: {
        kind: "text_delta",
        text: `[user:${session.user.id}] ${input.message}`,
      },
    })
    return cloudAgentJsonResponse(context, { event })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to append cloud agent message.",
      errorCode: "CLOUD_AGENT_TASK_MESSAGE_FAILED",
    })
  }
}
