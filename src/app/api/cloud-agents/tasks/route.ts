import { type NextRequest } from "next/server"

import { CLOUD_AGENT_MAX_CONCURRENT_PER_USER } from "@/lib/server/agent-runtime-config"
import {
  cloudAgentJsonResponse,
  CloudAgentNotFoundError,
  cloudAgentTaskCreateSchema,
  CloudAgentTransitionError,
  createCloudAgentRouteContext,
  createCloudAgentTask,
  dispatchCloudAgentTaskRequested,
  getCloudAgentEnvironment,
  handleCloudAgentError,
  listCloudAgentTasks,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
} from "@/lib/server/cloud-agents"

const CLOUD_AGENT_TASK_RETRY_AFTER_SECONDS = 60

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const context = createCloudAgentRouteContext({
    request,
    method: "GET",
    route: "/api/cloud-agents/tasks",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const environmentId = request.nextUrl.searchParams.get("environmentId")
    const tasks = await listCloudAgentTasks({
      userId: session.user.id,
      ...(environmentId ? { environmentId } : {}),
    })
    return cloudAgentJsonResponse(context, { tasks })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to list cloud agent tasks.",
      errorCode: "CLOUD_AGENT_TASK_LIST_FAILED",
    })
  }
}

export async function POST(request: NextRequest) {
  const context = createCloudAgentRouteContext({
    request,
    method: "POST",
    route: "/api/cloud-agents/tasks",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const payload: unknown = await request.json()
    const input = cloudAgentTaskCreateSchema.parse(payload)
    const environment = await getCloudAgentEnvironment(
      session.user.id,
      input.environmentId
    )
    if (!environment) {
      throw new CloudAgentNotFoundError("environment", input.environmentId)
    }
    let task
    try {
      task = await createCloudAgentTask({
        userId: session.user.id,
        environmentId: input.environmentId,
        prompt: input.prompt,
        maxConcurrentPerUser: CLOUD_AGENT_MAX_CONCURRENT_PER_USER,
      })
    } catch (error) {
      if (error instanceof CloudAgentTransitionError) {
        const resetAtSeconds =
          Math.floor(Date.now() / 1000) + CLOUD_AGENT_TASK_RETRY_AFTER_SECONDS
        return cloudAgentJsonResponse(
          context,
          {
            error: "Too many concurrent cloud agent tasks.",
            errorCode: "CLOUD_AGENT_TASK_CONCURRENCY_LIMIT",
          },
          {
            status: 429,
            headers: {
              "X-RateLimit-Limit": String(CLOUD_AGENT_MAX_CONCURRENT_PER_USER),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(resetAtSeconds),
              "Retry-After": String(CLOUD_AGENT_TASK_RETRY_AFTER_SECONDS),
            },
          }
        )
      }
      throw error
    }
    const dispatch = await dispatchCloudAgentTaskRequested({
      userId: session.user.id,
      taskId: task.id,
    })
    return cloudAgentJsonResponse(
      context,
      { task, dispatch: dispatch.delivery },
      { status: 202 }
    )
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to create cloud agent task.",
      errorCode: "CLOUD_AGENT_TASK_CREATE_FAILED",
    })
  }
}
