import { notFound, redirect } from "next/navigation"

import { CloudAgentTaskDetail } from "@/components/cloud-agents/cloud-agent-task-detail"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"
import { getCloudAgentTask } from "@/lib/server/cloud-agents"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ taskId: string }>
}

export default async function CloudAgentTaskPage({ params }: PageProps) {
  if (!isAuthConfigured()) {
    redirect("/sign-in")
  }
  const viewer = await getCurrentViewer()
  if (!viewer) {
    redirect("/sign-in?redirect=/cloud-agents")
  }

  const flags = await resolveAgentFeatureFlags({ userEmail: viewer.email })
  if (!flags.cloudAgentsEnabled) {
    redirect("/cloud-agents")
  }

  const { taskId } = await params
  const task = await getCloudAgentTask(viewer.id, taskId)
  if (!task) {
    notFound()
  }

  return <CloudAgentTaskDetail taskId={taskId} initialTask={task} />
}
