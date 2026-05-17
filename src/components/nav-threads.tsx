"use client"

import {
  ChevronRightIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react"
import { useCallback, useState } from "react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  sortThreadSummariesNewestFirst,
  type ThreadSummary,
} from "@/lib/shared"

const PINNED_STORAGE_KEY = "chloei:pinned-thread-ids"

function readPinned(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set()
  } catch {
    return new Set()
  }
}

function writePinned(ids: Set<string>) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore quota / serialization issues — pinning is best-effort UI state.
  }
}

export function NavThreads({
  threadSummaries,
  currentThreadId,
  onSelectThread,
  onDeleteThread,
}: {
  threadSummaries: ThreadSummary[]
  currentThreadId: string | null
  onSelectThread: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
}) {
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(readPinned)

  const togglePin = useCallback((threadId: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }
      writePinned(next)
      return next
    })
  }, [])

  const sorted = sortThreadSummariesNewestFirst(threadSummaries)
  const pinned = sorted.filter((t) => pinnedIds.has(t.id))
  const unpinned = sorted.filter((t) => !pinnedIds.has(t.id))
  const ordered = [...pinned, ...unpinned]

  return (
    <SidebarGroup>
      <Collapsible defaultOpen>
        <CollapsibleTrigger
          render={
            <SidebarGroupLabel
              render={<button type="button" />}
              className="group/threads-label w-fit cursor-pointer gap-0.5 hover:text-sidebar-foreground"
            />
          }
        >
          <span>Threads</span>
          <ChevronRightIcon
            strokeWidth={1.5}
            className="size-3 transition-transform duration-150 group-aria-expanded/threads-label:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu>
            {ordered.length === 0 ? (
              <SidebarMenuItem>
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  No chats yet.
                </div>
              </SidebarMenuItem>
            ) : (
              ordered.map((thread) => {
                const isPinned = pinnedIds.has(thread.id)
                return (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      isActive={thread.id === currentThreadId}
                      tooltip={thread.title}
                      onClick={() => {
                        onSelectThread(thread.id)
                      }}
                    >
                      {isPinned ? (
                        <PinIcon className="text-muted-foreground" />
                      ) : null}
                      <span>{thread.title}</span>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction
                          showOnHover
                          className="aria-expanded:bg-muted"
                          aria-label="Thread actions"
                        >
                          <MoreHorizontalIcon />
                          <span className="sr-only">More</span>
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="right"
                        align="start"
                        className="min-w-40"
                      >
                        <DropdownMenuItem
                          onSelect={() => {
                            togglePin(thread.id)
                          }}
                        >
                          {isPinned ? (
                            <>
                              <PinOffIcon className="text-muted-foreground" />
                              <span>Unpin chat</span>
                            </>
                          ) : (
                            <>
                              <PinIcon className="text-muted-foreground" />
                              <span>Pin chat</span>
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => {
                            onDeleteThread(thread.id)
                            if (isPinned) togglePin(thread.id)
                          }}
                        >
                          <Trash2Icon />
                          <span>Delete chat</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                )
              })
            )}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
