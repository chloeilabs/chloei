"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { SearchIcon } from "lucide-react"
import { useState } from "react"

import { Input } from "@/components/ui/input"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import {
  sortThreadSummariesNewestFirst,
  type ThreadSummary,
} from "@/lib/shared"

export function SearchChats({
  threadSummaries,
  isLoading,
  onSelectThread,
}: {
  threadSummaries: ThreadSummary[]
  isLoading?: boolean
  onSelectThread: (threadId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const sorted = sortThreadSummariesNewestFirst(threadSummaries)
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? sorted.filter((thread) => thread.title.toLowerCase().includes(trimmed))
    : sorted

  const handleSelect = (threadId: string) => {
    onSelectThread(threadId)
    setOpen(false)
    setQuery("")
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <DialogPrimitive.Trigger
        render={
          <SidebarMenuButton tooltip="Search chats" className="h-8 px-2">
            <SearchIcon />
            <span>Search chats</span>
          </SidebarMenuButton>
        }
      />
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
        <DialogPrimitive.Popup className="fixed top-[20vh] left-1/2 z-50 flex w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg transition duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
          <DialogPrimitive.Title className="sr-only">
            Search chats
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Filter your existing chats by title.
          </DialogPrimitive.Description>
          <div className="border-b border-border">
            <Input
              ref={(node) => {
                if (node && open) node.focus()
              }}
              placeholder="Search chats…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              className="h-12 rounded-md border-0 bg-transparent px-4 text-base shadow-none focus-visible:ring-0 md:text-base"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1">
            {isLoading && filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading chats...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No chats found.
              </div>
            ) : (
              filtered.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    handleSelect(thread.id)
                  }}
                  className="flex w-full min-w-0 cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {thread.title}
                  </span>
                </button>
              ))
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
