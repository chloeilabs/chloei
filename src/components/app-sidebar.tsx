"use client"

import "@/components/graphics/logo/logo-animation.css"

import { SearchIcon, SquarePenIcon } from "lucide-react"
import dynamic from "next/dynamic"
import Link from "next/link"
import * as React from "react"

import { ChloeiLogoHoverSvg } from "@/components/graphics/logo/logo-hover-svg"
import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import type { AuthViewer, ThreadSummary } from "@/lib/shared"

function SearchChatsPlaceholder() {
  return (
    <SidebarMenuButton tooltip="Search chats" disabled className="gap-2">
      <SearchIcon />
      <span>Search chats</span>
    </SidebarMenuButton>
  )
}

function ThreadListSkeleton() {
  return (
    <SidebarGroup>
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
    </SidebarGroup>
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
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row items-center gap-1 group-data-[collapsible=icon]:justify-center">
            <SidebarMenuButton
              className="group/chloei-home h-7 min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:hidden hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
              onClick={handleNewChat}
              render={<Link href="/" aria-label="Chloei home" />}
            >
              <span className="relative block size-4 shrink-0 overflow-hidden">
                <span className="absolute inset-0 transition-opacity duration-100 group-hover/chloei-home:opacity-0 group-focus-visible/chloei-home:opacity-0">
                  <ChloeiLogoSvg className="size-full!" />
                </span>
                <span className="absolute inset-0 opacity-0 transition-opacity duration-100 group-hover/chloei-home:opacity-100 group-focus-visible/chloei-home:opacity-100">
                  <span className="block h-4 w-[240px]">
                    <ChloeiLogoHoverSvg className="logo-sm size-full! [animation-play-state:paused] group-hover/chloei-home:[animation-play-state:running] group-focus-visible/chloei-home:[animation-play-state:running]" />
                  </span>
                </span>
              </span>
              <span className="truncate text-sm leading-none font-medium tracking-tight">
                Chloei
              </span>
            </SidebarMenuButton>
            <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                onClick={handleNewChat}
                className="gap-2"
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
        </SidebarGroup>
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
      <SidebarFooter>
        <NavUser viewer={viewer} />
      </SidebarFooter>
    </Sidebar>
  )
}
