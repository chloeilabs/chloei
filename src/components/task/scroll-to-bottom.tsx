import { ArrowDown } from "lucide-react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import { cn } from "@/lib/utils"

import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

export function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  return (
    <Tooltip disableHoverableContent={isAtBottom}>
      <TooltipTrigger asChild>
        <button
          disabled={isAtBottom}
          className={cn(
            "sticky z-20 rounded-none border border-border bg-background p-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground",
            isAtBottom
              ? "translate-y-2 opacity-0"
              : "translate-y-0 cursor-pointer opacity-100",
            "bottom-38"
          )}
          onClick={() => scrollToBottom()}
        >
          <ArrowDown className="size-4" />
        </button>
      </TooltipTrigger>
      {!isAtBottom && <TooltipContent>Scroll to Bottom</TooltipContent>}
    </Tooltip>
  )
}
