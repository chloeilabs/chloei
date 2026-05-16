import { type NextRequest } from "next/server"

import { continueCloudAgentTaskAfterApproval } from "@/lib/server/cloud-agents"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.CLOUD_AGENT_DEV_BYPASS !== "1"
  ) {
    return new Response("dev bypass disabled", { status: 404 })
  }
  const body = (await request.json()) as {
    userId?: string
    taskId?: string
    approved?: boolean
  }
  if (!body.userId || !body.taskId) {
    return Response.json(
      { error: "userId and taskId required" },
      { status: 400 }
    )
  }
  // Fire-and-forget; runtime drives the post-approval flow in-process
  void continueCloudAgentTaskAfterApproval({
    userId: body.userId,
    taskId: body.taskId,
    approved: body.approved !== false,
  })
  return Response.json({ accepted: true })
}
