import { redirect } from "next/navigation"

import { TradingDesk } from "@/components/trading-desk/trading-desk"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"

export const dynamic = "force-dynamic"

export default async function TradingDeskPage() {
  if (!isAuthConfigured()) {
    redirect("/sign-in")
  }

  const viewer = await getCurrentViewer()
  if (!viewer) {
    redirect("/sign-in")
  }

  return <TradingDesk viewer={viewer} />
}
