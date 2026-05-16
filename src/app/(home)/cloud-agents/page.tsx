import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query"
import { redirect } from "next/navigation"

import { CloudAgentsDashboard } from "@/components/cloud-agents/cloud-agents-dashboard"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"
import {
  listCloudAgentEnvironments,
  listCloudAgentTasks,
} from "@/lib/server/cloud-agents"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"

export const dynamic = "force-dynamic"

export default async function CloudAgentsPage() {
  if (!isAuthConfigured()) {
    redirect("/sign-in")
  }
  const viewer = await getCurrentViewer()
  if (!viewer) {
    redirect("/sign-in?redirect=/cloud-agents")
  }

  const flags = await resolveAgentFeatureFlags({ userEmail: viewer.email })
  if (!flags.cloudAgentsEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 text-center">
        <h1 className="font-departureMono text-xl tracking-tight">
          Cloud agents
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Cloud agents are not enabled for your account yet. Ask an admin to
          enable the <code>agent.cloud_agents.enabled</code> flag.
        </p>
      </div>
    )
  }

  const queryClient = new QueryClient()
  const [environments, tasks] = await Promise.all([
    listCloudAgentEnvironments(viewer.id),
    listCloudAgentTasks({ userId: viewer.id }),
  ])
  queryClient.setQueryData(["cloud-agent-environments"], environments)
  queryClient.setQueryData(["cloud-agent-tasks"], tasks)

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <CloudAgentsDashboard
        initialEnvironments={environments}
        initialTasks={tasks}
      />
    </HydrationBoundary>
  )
}
