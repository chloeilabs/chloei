import { type NextRequest } from "next/server"

import {
  cloudAgentErrorResponse,
  cloudAgentJsonResponse,
  cloudAgentTaskApproveSchema,
  createCloudAgentRouteContext,
  dispatchCloudAgentApprovalReceived,
  getLatestApprovalRequiredId,
  handleCloudAgentError,
  requireCloudAgentsEnabled,
  requireCloudAgentSession,
  requireCloudAgentTaskTransition,
} from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

interface RouteContext {
  params: Promise<{ taskId: string }>
}

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const context = createCloudAgentRouteContext({
    request,
    method: "POST",
    route: "/api/cloud-agents/tasks/[taskId]/approve",
  })
  try {
    const session = await requireCloudAgentSession(context)
    if (session instanceof Response) return session
    const flagsOrError = await requireCloudAgentsEnabled(context, session)
    if (flagsOrError instanceof Response) return flagsOrError
    const { taskId } = await routeContext.params
    const payload: unknown = await request.json()
    const input = cloudAgentTaskApproveSchema.parse(payload)
    await requireCloudAgentTaskTransition({
      userId: session.user.id,
      taskId,
      from: ["waiting_for_approval"],
    })
    // Validate the supplied approvalId matches the latest pending
    // `approval_required` event for this task. Without this check,
    // any authenticated owner could approve with an arbitrary
    // approvalId and the audit trail would be meaningless.
    const expectedApprovalId = await getLatestApprovalRequiredId({
      userId: session.user.id,
      taskId,
    })
    if (!expectedApprovalId || expectedApprovalId !== input.approvalId) {
      return cloudAgentErrorResponse(context, {
        error: "Approval id does not match the pending approval for this task.",
        errorCode: "CLOUD_AGENT_TASK_APPROVE_STALE",
        status: 409,
      })
    }
    const dispatch = await dispatchCloudAgentApprovalReceived({
      userId: session.user.id,
      taskId,
      approved: input.decision === "approve",
      ...(input.note ? { note: input.note } : {}),
    })
    return cloudAgentJsonResponse(context, {
      accepted: true,
      decision: input.decision,
      dispatch: dispatch.delivery,
    })
  } catch (error) {
    return handleCloudAgentError(context, error, {
      error: "Failed to record cloud agent approval.",
      errorCode: "CLOUD_AGENT_TASK_APPROVE_FAILED",
    })
  }
}
