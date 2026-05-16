import { type NextRequest } from "next/server"

import {
  cloudAgentEnvironmentUpdateSchema,
  cloudAgentJsonResponse,
  CloudAgentNotFoundError,
  createCloudAgentRouteContext,
  deleteCloudAgentEnvironment,
  getCloudAgentEnvironment,
  handleCloudAgentError,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
  updateCloudAgentEnvironment,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

interface RouteContext {
  params: Promise<{ environmentId: string }>
}

export async function GET(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "GET",
    route: "/api/cloud-agents/environments/[environmentId]",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { environmentId } = await routeContext.params
    const environment = await getCloudAgentEnvironment(
      session.user.id,
      environmentId
    )
    if (!environment) {
      throw new CloudAgentNotFoundError("environment", environmentId)
    }
    return cloudAgentJsonResponse(context, { environment })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to load cloud agent environment.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_LOAD_FAILED",
    })
  }
}

export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "PATCH",
    route: "/api/cloud-agents/environments/[environmentId]",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { environmentId } = await routeContext.params
    const payload: unknown = await request.json()
    const input = cloudAgentEnvironmentUpdateSchema.parse(payload)
    const environment = await updateCloudAgentEnvironment(
      session.user.id,
      environmentId,
      input
    )
    return cloudAgentJsonResponse(context, { environment })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to update cloud agent environment.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_UPDATE_FAILED",
    })
  }
}

export async function DELETE(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "DELETE",
    route: "/api/cloud-agents/environments/[environmentId]",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { environmentId } = await routeContext.params
    await deleteCloudAgentEnvironment(session.user.id, environmentId)
    return cloudAgentJsonResponse(context, { deleted: true })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to delete cloud agent environment.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_DELETE_FAILED",
    })
  }
}
