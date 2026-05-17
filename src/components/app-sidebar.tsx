"use client"

import "@/components/graphics/logo/logo-animation.css"

import { SquarePenIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { ChloeiLogoHoverSvg } from "@/components/graphics/logo/logo-hover-svg"
import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { NavThreads } from "@/components/nav-threads"
import { NavUser } from "@/components/nav-user"
import { SearchChats } from "@/components/search-chats"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { AuthViewer, ThreadSummary } from "@/lib/shared"

export function AppSidebar({
  viewer,
  threadSummaries,
  currentThreadId,
  onSelectThread,
  onDeleteThread,
  onNewChat,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  viewer: AuthViewer
  threadSummaries: ThreadSummary[]
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

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="group/chloei-home h-7 gap-2 hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
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
              <span className="truncate font-departureMono text-sm leading-none font-medium tracking-tight">
                Chloei
              </span>
            </SidebarMenuButton>
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
              <SearchChats
                threadSummaries={threadSummaries}
                onSelectThread={handleSelectThread}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <NavThreads
          threadSummaries={threadSummaries}
          currentThreadId={currentThreadId}
          onSelectThread={handleSelectThread}
          onDeleteThread={onDeleteThread}
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser viewer={viewer} />
      </SidebarFooter>
    </Sidebar>
  )
}
