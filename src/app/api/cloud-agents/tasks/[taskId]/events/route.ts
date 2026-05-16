import { type NextRequest } from "next/server"

import {
  cloudAgentJsonResponse,
  createCloudAgentRouteContext,
  getCloudAgentTask,
  handleCloudAgentError,
  listCloudAgentTaskEvents,
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
    route: "/api/cloud-agents/tasks/[taskId]/events",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { taskId } = await routeContext.params
    const task = await getCloudAgentTask(session.user.id, taskId)
    if (!task) {
      return cloudAgentJsonResponse(context, {
        task: null,
        events: [],
      })
    }
    const afterParam = request.nextUrl.searchParams.get("after")
    const afterSeq = afterParam ? Math.max(parseInt(afterParam, 10) || 0, 0) : 0
    const limitParam = request.nextUrl.searchParams.get("limit")
    const limit = limitParam
      ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 500)
      : 200
    const events = await listCloudAgentTaskEvents({
      userId: session.user.id,
      taskId,
      afterSeq,
      limit,
    })
    const lastSeq =
      events.length > 0 ? events[events.length - 1]?.seq : afterSeq
    return cloudAgentJsonResponse(context, {
      task,
      events,
      lastSeq: lastSeq ?? afterSeq,
    })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to load cloud agent task events.",
      errorCode: "CLOUD_AGENT_TASK_EVENTS_LOAD_FAILED",
    })
  }
}
