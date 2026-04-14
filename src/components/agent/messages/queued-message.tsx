import { ListEnd, X } from "lucide-react"

import { Button } from "@/components/ui/button"

export function QueuedAction({
  message,
  onClear,
}: {
  message: string
  onClear: () => void
}) {
  const previewText = message.trim()

  return (
    <div className="absolute -top-12 left-0 flex w-full animate-in items-center justify-between gap-2 rounded-none border border-border bg-card py-1.5 pr-1.5 pl-3 text-sm duration-150 fade-in">
      <div className="flex items-center gap-1.5 overflow-hidden">
        <ListEnd className="size-4" />
        <span className="whitespace-nowrap select-none">Queued Message</span>
        <span className="truncate text-muted-foreground">{previewText}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="iconXs"
        className="p-0 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
        onClick={onClear}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
