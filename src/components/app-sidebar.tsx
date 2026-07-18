"use client"

import { SearchIcon, SquarePenIcon } from "lucide-react"
import dynamic from "next/dynamic"
import * as React from "react"

import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import type { AuthViewer, ThreadSummary } from "@/lib/shared"

const TRIGGER_CLASS = "size-8 text-white/70 hover:bg-white/10 hover:text-white"

function SearchChatsPlaceholder() {
  return (
    <SidebarMenuButton
      tooltip="Search chats"
      disabled
      className="h-8 gap-2 px-2"
    >
      <SearchIcon />
      <span>Search chats</span>
    </SidebarMenuButton>
  )
}

function ThreadListSkeleton() {
  return (
    <div className="px-0.5 pt-3">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
        Threads
      </div>
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  )
}

const SearchChats = dynamic(
  () => import("@/components/search-chats").then((mod) => mod.SearchChats),
  {
    ssr: false,
    loading: () => <SearchChatsPlaceholder />,
  }
)

const NavThreads = dynamic(
  () => import("@/components/nav-threads").then((mod) => mod.NavThreads),
  {
    ssr: false,
    loading: () => <ThreadListSkeleton />,
  }
)

export function AppSidebar({
  viewer,
  threadSummaries,
  isThreadSummariesLoading,
  currentThreadId,
  onSelectThread,
  onDeleteThread,
  onNewChat,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  viewer: AuthViewer
  threadSummaries: ThreadSummary[]
  isThreadSummariesLoading?: boolean
  currentThreadId: string | null
  onSelectThread: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onNewChat: () => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  const closeMobileSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }, [isMobile, setOpenMobile])

  const handleSelectThread = React.useCallback(
    (threadId: string) => {
      onSelectThread(threadId)
      closeMobileSidebar()
    },
    [onSelectThread, closeMobileSidebar]
  )

  const handleNewChat = React.useCallback(() => {
    onNewChat()
    closeMobileSidebar()
  }, [onNewChat, closeMobileSidebar])
  const shouldShowThreadLoading =
    isThreadSummariesLoading && threadSummaries.length === 0

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="px-2.5 pt-3">
        {/* Toggle sits on the right when open; when collapsed it drops to the
            left of the rail to line up with the New chat icon. */}
        <div className="flex items-center justify-between gap-1 group-data-[collapsible=icon]:justify-start">
          <button
            type="button"
            onClick={handleNewChat}
            className="pl-2 text-lg font-semibold group-data-[collapsible=icon]:hidden"
          >
            Chloei
          </button>
          <SidebarTrigger className={TRIGGER_CLASS} />
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2.5 pt-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* h-8 + px-2 match the collapsed icon button (size-8, p-2), so the
                New chat icon stays at the exact same x AND y when the sidebar
                opens/closes. */}
            <SidebarMenuButton
              className="h-8 px-2"
              tooltip="New chat"
              onClick={handleNewChat}
            >
              <SquarePenIcon />
              <span>New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {shouldShowThreadLoading ? (
              <SearchChatsPlaceholder />
            ) : (
              <SearchChats
                threadSummaries={threadSummaries}
                isLoading={isThreadSummariesLoading}
                onSelectThread={handleSelectThread}
              />
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="min-h-0 group-data-[collapsible=icon]:hidden">
          {shouldShowThreadLoading ? (
            <ThreadListSkeleton />
          ) : (
            <NavThreads
              threadSummaries={threadSummaries}
              isLoading={isThreadSummariesLoading}
              currentThreadId={currentThreadId}
              onSelectThread={handleSelectThread}
              onDeleteThread={onDeleteThread}
            />
          )}
        </div>
      </SidebarContent>
      <SidebarFooter className="px-2.5 pb-2">
        <NavUser viewer={viewer} />
      </SidebarFooter>
    </Sidebar>
  )
}
