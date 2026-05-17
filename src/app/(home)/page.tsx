import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query"
import { redirect } from "next/navigation"

import { HomePageContent } from "@/components/agent/home/home-content"
import { QueryClientProvider } from "@/components/layout/query-client-provider"
import { getModels } from "@/lib/actions/api-keys"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"
import {
  getModelSelectorModels,
  resolveDefaultModelSelectorModel,
} from "@/lib/shared"

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
  const modelSelectorModels = getModelSelectorModels(availableModels)

  queryClient.setQueryData(["models"], availableModels)

  const resolvedInitialSelectedModel =
    modelSelectorModels.length > 0
      ? resolveDefaultModelSelectorModel(modelSelectorModels)
      : null

  return (
    <QueryClientProvider>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <HomePageContent
          initialSelectedModel={resolvedInitialSelectedModel}
          viewer={viewer}
        />
      </HydrationBoundary>
    </QueryClientProvider>
  )
}
