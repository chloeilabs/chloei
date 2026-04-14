"use client"

import {
  ChevronDown,
  type LucideIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Search,
  Trash2,
  X,
} from "lucide-react"
import {
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"

import { LogoBurst } from "@/components/graphics/logo/logo-burst"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { type Thread, THREAD_TITLE_MAX_LENGTH } from "@/lib/shared"
import { cn } from "@/lib/utils"

import { useThreads } from "./threads-context"

const DAY_IN_MS = 24 * 60 * 60 * 1_000

function getThreadSearchValue(thread: Thread) {
  return `${thread.title} ${thread.messages.map((message) => message.content).join(" ")}`
    .toLowerCase()
    .trim()
}

function getSortTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function sortThreadsByRecency(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => {
    const updatedDelta =
      getSortTimestamp(right.updatedAt) - getSortTimestamp(left.updatedAt)

    if (updatedDelta !== 0) {
      return updatedDelta
    }

    const createdDelta =
      getSortTimestamp(right.createdAt) - getSortTimestamp(left.createdAt)

    if (createdDelta !== 0) {
      return createdDelta
    }

    return left.id.localeCompare(right.id)
  })
}

function getThreadDateGroupLabel(updatedAt: string) {
  const targetDate = new Date(updatedAt)

  if (Number.isNaN(targetDate.getTime())) {
    return "Older"
  }

  const now = new Date()
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  )
  const startOfTarget = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  )
  const dayDelta = Math.floor(
    (startOfToday.getTime() - startOfTarget.getTime()) / DAY_IN_MS
  )

  if (dayDelta <= 0) {
    return "Today"
  }

  if (dayDelta === 1) {
    return "Yesterday"
  }

  if (dayDelta < 7) {
    return "Previous 7 Days"
  }

  return targetDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  })
}

function groupThreadsForSearch(threads: Thread[]) {
  const groups: { label: string; threads: Thread[] }[] = []

  for (const thread of threads) {
    const label = getThreadDateGroupLabel(thread.updatedAt)
    const currentGroup = groups[groups.length - 1]

    if (currentGroup?.label !== label) {
      groups.push({
        label,
        threads: [thread],
      })
      continue
    }

    currentGroup.threads.push(thread)
  }

  return groups
}

function ChatsLabel({
  isExpanded,
  onToggle,
}: {
  isExpanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 pt-1 pb-1 text-left text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground focus-visible:outline-none"
    >
      <span>Your chats</span>
      <ChevronDown
        className={cn(
          "size-3 text-sidebar-foreground/70 transition-transform duration-150",
          !isExpanded && "-rotate-90"
        )}
      />
    </button>
  )
}

function ThreadMenuItem({
  icon: Icon,
  children,
  onClick,
  destructive = false,
}: {
  icon: LucideIcon
  children: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <DropdownMenuItem
      onClick={onClick}
      variant={destructive ? "destructive" : "default"}
      className="cursor-pointer"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}

export function AppSidebar({ onGoHome }: { onGoHome?: () => void }) {
  const {
    threads,
    currentThreadId,
    setCurrentThreadId,
    renameThread,
    toggleThreadPinned,
    deleteThread,
  } = useThreads()
  const { setOpenMobile } = useSidebar()
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isChatsExpanded, setIsChatsExpanded] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const deferredSearchQuery = useDeferredValue(searchQuery)

  useEffect(() => {
    if (!editingThreadId || !renameInputRef.current) {
      return
    }

    renameInputRef.current.focus()
    renameInputRef.current.select()
  }, [editingThreadId])

  useEffect(() => {
    if (!isSearchOpen || !searchInputRef.current) {
      return
    }

    searchInputRef.current.focus()
    searchInputRef.current.select()
  }, [isSearchOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isSearchOpen])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setEditingThreadId(null)
        setRenameDraft("")
        setSearchQuery("")
        setOpenMobile(false)
        setIsSearchOpen(true)
        return
      }

      if (event.key === "Escape") {
        setIsSearchOpen(false)
        setSearchQuery("")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [setOpenMobile])

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase()
  const searchResults = sortThreadsByRecency(
    normalizedSearchQuery === ""
      ? threads
      : threads.filter((thread) =>
          getThreadSearchValue(thread).includes(normalizedSearchQuery)
        )
  )
  const searchGroups = groupThreadsForSearch(searchResults)

  const stopRenaming = () => {
    setEditingThreadId(null)
    setRenameDraft("")
  }

  const closeSearch = () => {
    setIsSearchOpen(false)
    setSearchQuery("")
  }

  const openSearch = () => {
    stopRenaming()
    setOpenMobile(false)
    setSearchQuery("")
    setIsSearchOpen(true)
  }

  const submitRename = () => {
    if (!editingThreadId) {
      return
    }

    const thread = threads.find((candidate) => candidate.id === editingThreadId)

    if (!thread) {
      stopRenaming()
      return
    }

    if (renameDraft.trim() !== thread.title.trim()) {
      renameThread(editingThreadId, renameDraft)
    }

    stopRenaming()
  }

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submitRename()
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      stopRenaming()
    }
  }

  const handleSelectThread = (threadId: string) => {
    closeSearch()
    setCurrentThreadId(threadId)
    setOpenMobile(false)
  }

  const handleGoHome = () => {
    closeSearch()
    stopRenaming()

    if (onGoHome) {
      onGoHome()
    } else {
      setCurrentThreadId(null)
    }

    setOpenMobile(false)
  }

  const renderThreadList = (items: Thread[]) => {
    return (
      <SidebarMenu className="gap-0.5">
        {items.map((thread) => {
          const isEditing = editingThreadId === thread.id

          return (
            <SidebarMenuItem key={thread.id}>
              {isEditing ? (
                <div className="border border-sidebar-border bg-background p-1">
                  <SidebarInput
                    ref={renameInputRef}
                    value={renameDraft}
                    maxLength={THREAD_TITLE_MAX_LENGTH}
                    onChange={(event) => {
                      setRenameDraft(event.target.value)
                    }}
                    onBlur={submitRename}
                    onKeyDown={handleRenameKeyDown}
                    placeholder="Rename thread"
                    className="h-8 border-0 bg-transparent px-2 py-1 text-xs shadow-none focus-visible:ring-1"
                  />
                </div>
              ) : (
                <>
                  <SidebarMenuButton
                    isActive={thread.id === currentThreadId}
                    onClick={() => {
                      handleSelectThread(thread.id)
                    }}
                    className="h-auto min-h-0 rounded-none px-2.5 py-2 text-sm font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground data-active:bg-sidebar-accent/70 data-active:font-normal data-active:text-sidebar-foreground"
                  >
                    {thread.isPinned ? (
                      <Pin className="size-3.5 shrink-0 text-sidebar-foreground" />
                    ) : null}
                    <span className="truncate">{thread.title}</span>
                  </SidebarMenuButton>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover className="cursor-pointer">
                        <MoreHorizontal />
                        <span className="sr-only">More</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-52"
                      side="bottom"
                      align="end"
                    >
                      <ThreadMenuItem
                        icon={Pencil}
                        onClick={() => {
                          setEditingThreadId(thread.id)
                          setRenameDraft(thread.title)
                        }}
                      >
                        Rename thread
                      </ThreadMenuItem>
                      <ThreadMenuItem
                        icon={Pin}
                        onClick={() => {
                          toggleThreadPinned(thread.id)
                        }}
                      >
                        {thread.isPinned ? "Unpin thread" : "Pin thread"}
                      </ThreadMenuItem>
                      <DropdownMenuSeparator />
                      <ThreadMenuItem
                        icon={Trash2}
                        onClick={() => {
                          deleteThread(thread.id)
                        }}
                        destructive
                      >
                        Delete thread
                      </ThreadMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    )
  }

  const searchOverlay =
    isSearchOpen && typeof document !== "undefined"
      ? createPortal(
          <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-16 pb-6 md:px-6 md:pt-20">
            <button
              type="button"
              aria-label="Close search"
              onClick={closeSearch}
              className="absolute inset-0 bg-black/35 supports-backdrop-filter:backdrop-blur-xs"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Search chats"
              className="relative flex max-h-[min(74vh,680px)] w-full max-w-3xl flex-col overflow-hidden rounded-none border border-border bg-background shadow-lg"
            >
              <div className="flex items-center gap-3 border-b border-border py-3 pr-[11px] pl-4">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                  }}
                  placeholder="Search chats..."
                  className="h-8 w-full border-0 bg-transparent px-0 text-base text-foreground outline-none placeholder:text-muted-foreground/60 md:text-sm"
                />
                <button
                  type="button"
                  onClick={closeSearch}
                  aria-label="Close search"
                  className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-none border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto pb-4">
                {searchGroups.map((group) => (
                  <div key={group.label}>
                    <div className="flex h-10 items-center px-4 text-[10px] leading-none tracking-[0.18em] text-muted-foreground/70 uppercase">
                      {group.label}
                    </div>
                    <div className="border-y border-border/60">
                      {group.threads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => {
                            handleSelectThread(thread.id)
                          }}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40",
                            thread.id === currentThreadId && "bg-accent/45"
                          )}
                        >
                          <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {thread.title}
                          </span>
                          {thread.isPinned ? (
                            <Pin className="size-3.5 shrink-0 text-muted-foreground/75" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                {searchResults.length === 0 ? (
                  <div className="px-5 py-10 text-sm text-muted-foreground">
                    No threads match your search.
                  </div>
                ) : null}
              </div>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border/70 p-3">
          <div
            role="button"
            tabIndex={0}
            onClick={handleGoHome}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                handleGoHome()
              }
            }}
            className="flex h-7 w-full cursor-pointer items-center gap-3 overflow-hidden px-2 group-data-[collapsible=icon]:translate-x-px group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:self-center group-data-[collapsible=icon]:px-0"
          >
            <LogoBurst className="shrink-0" size="md" />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="font-departureMono text-[18px] leading-none tracking-[0.08em] text-sidebar-foreground">
                Yurie
              </p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {threads.length > 0 && (
            <SidebarGroup className="translate-x-px">
              <SidebarGroupContent className="space-y-4">
                <SidebarMenu className="gap-1">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="New chat"
                      onClick={handleGoHome}
                      className="h-auto min-h-0 cursor-pointer justify-start gap-3 rounded-none px-2.5 py-2 text-sm font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                    >
                      <Pencil className="size-4 text-sidebar-foreground" />
                      <span>New chat</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="Search chats"
                      onClick={openSearch}
                      className="h-auto min-h-0 cursor-pointer justify-start gap-3 rounded-none px-2.5 py-2 text-sm font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                    >
                      <Search className="size-4 text-sidebar-foreground" />
                      <span>Search chats</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>

                <div className="group-data-[collapsible=icon]:hidden">
                  <ChatsLabel
                    isExpanded={isChatsExpanded}
                    onToggle={() => {
                      setIsChatsExpanded((current) => !current)
                    }}
                  />
                  {isChatsExpanded ? renderThreadList(threads) : null}
                </div>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarRail />
      </Sidebar>

      {searchOverlay}
    </>
  )
}
