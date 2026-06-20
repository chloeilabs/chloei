import { ArrowDown } from "lucide-react"
import { useCallback, useRef } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

export function ScrollToBottom() {
  const stickToBottom = useStickToBottomContext()
  const manualScrollInFlightRef = useRef(false)
  const { isAtBottom } = stickToBottom

  // use-stick-to-bottom exposes targetScrollTop as a mutable override point.
  // eslint-disable-next-line react-hooks/immutability
  const handleScrollToBottom = useCallback(async () => {
    if (manualScrollInFlightRef.current) {
      return
    }

    manualScrollInFlightRef.current = true
    const previousTargetScrollTop = stickToBottom.targetScrollTop
    // eslint-disable-next-line react-hooks/immutability
    stickToBottom.targetScrollTop = (targetScrollTop) => targetScrollTop

    try {
      await stickToBottom.scrollToBottom()
    } finally {
      stickToBottom.targetScrollTop = previousTargetScrollTop
      manualScrollInFlightRef.current = false
    }
  }, [stickToBottom])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="secondary"
          size="icon-sm"
          disabled={isAtBottom}
          className={cn(
            "sticky bottom-[9.5rem] z-20 border border-border text-muted-foreground transition-all hover:text-foreground disabled:opacity-0",
            isAtBottom ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
          )}
          onClick={() => {
            void handleScrollToBottom()
          }}
        >
          <ArrowDown />
        </Button>
      </TooltipTrigger>
      {!isAtBottom && <TooltipContent>Scroll to Bottom</TooltipContent>}
    </Tooltip>
  )
}
