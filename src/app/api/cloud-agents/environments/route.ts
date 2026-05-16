import { type NextRequest } from "next/server"

import {
  cloudAgentEnvironmentCreateSchema,
  cloudAgentJsonResponse,
  createCloudAgentEnvironment,
  createCloudAgentRouteContext,
  handleCloudAgentError,
  listCloudAgentEnvironments,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const context = createCloudAgentRouteContext({
    request,
    method: "GET",
    route: "/api/cloud-agents/environments",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const environments = await listCloudAgentEnvironments(session.user.id)
    return cloudAgentJsonResponse(context, { environments })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to list cloud agent environments.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_LIST_FAILED",
    })
  }
}

export async function POST(request: NextRequest) {
  const context = createCloudAgentRouteContext({
    request,
    method: "POST",
    route: "/api/cloud-agents/environments",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const payload: unknown = await request.json()
    const input = cloudAgentEnvironmentCreateSchema.parse(payload)
    const environment = await createCloudAgentEnvironment(
      session.user.id,
      input
    )
    return cloudAgentJsonResponse(context, { environment }, { status: 201 })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to create cloud agent environment.",
      errorCode: "CLOUD_AGENT_ENVIRONMENT_CREATE_FAILED",
    })
  }
}
