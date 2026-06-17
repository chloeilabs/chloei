import { redirect } from "next/navigation"

import { HomePageContent } from "@/components/agent/home/home-content"
import { ModelsProvider } from "@/hooks/agent/use-models"
import { getModels } from "@/lib/actions/api-keys"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"

export const dynamic = "force-dynamic"

export default async function Home() {
  if (!isAuthConfigured()) {
    redirect("/sign-in")
  }

  const viewer = await getCurrentViewer()

  if (!viewer) {
    redirect("/sign-in")
  }

  const availableModels = getModels()

  return (
    <ModelsProvider models={availableModels}>
      <HomePageContent viewer={viewer} />
    </ModelsProvider>
  )
}
