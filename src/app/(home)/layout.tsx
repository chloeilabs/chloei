import { ThreadStoreProvider } from "@/components/agent/home/thread-store-context"
import { RouteGroupLayout } from "@/components/layout/route-group-layout"

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThreadStoreProvider>
      <RouteGroupLayout>{children}</RouteGroupLayout>
    </ThreadStoreProvider>
  )
}
