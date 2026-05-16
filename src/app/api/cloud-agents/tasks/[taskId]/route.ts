import { type NextRequest } from "next/server"

import {
  cloudAgentJsonResponse,
  CloudAgentNotFoundError,
  createCloudAgentRouteContext,
  getCloudAgentTask,
  handleCloudAgentError,
  listCloudAgentArtifacts,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

interface RouteContext {
  params: Promise<{ taskId: string }>
}

export async function GET(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "GET",
    route: "/api/cloud-agents/tasks/[taskId]",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { taskId } = await routeContext.params
    const task = await getCloudAgentTask(session.user.id, taskId)
    if (!task) {
      throw new CloudAgentNotFoundError("task", taskId)
    }
    const artifacts = await listCloudAgentArtifacts({
      userId: session.user.id,
      taskId,
    })
    return cloudAgentJsonResponse(context, { task, artifacts })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to load cloud agent task.",
      errorCode: "CLOUD_AGENT_TASK_LOAD_FAILED",
    })
  }
}
