import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query"
import { redirect } from "next/navigation"

import { HomePageContent } from "@/components/agent/home/home-content"
import { getModels } from "@/lib/actions/api-keys"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"
import { listThreadsForUser } from "@/lib/server/threads"
import { resolveDefaultModel } from "@/lib/shared"

export default async function Home() {
  if (!isAuthConfigured()) {
    redirect("/sign-in")
  }

  const viewer = await getCurrentViewer()

  if (!viewer) {
    redirect("/sign-in")
  }

  const queryClient = new QueryClient()

  const availableModels = getModels()
  const initialThreads = await listThreadsForUser(viewer.id)

  queryClient.setQueryData(["models"], availableModels)

  const resolvedInitialSelectedModel =
    availableModels.length > 0 ? resolveDefaultModel(availableModels) : null

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageContent
        initialSelectedModel={resolvedInitialSelectedModel}
        initialThreads={initialThreads}
        viewer={viewer}
      />
    </HydrationBoundary>
  )
}
