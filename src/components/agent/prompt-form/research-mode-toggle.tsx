import { Telescope } from "lucide-react"
import { useEffect } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AgentRunMode } from "@/lib/shared"
import { cn } from "@/lib/utils"

export function ResearchModeToggle({
  runMode,
  onRunModeChange,
  disabled = false,
}: {
  runMode: AgentRunMode
  onRunModeChange: (runMode: AgentRunMode) => void
  disabled?: boolean
}) {
  const isResearch = runMode === "research"

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !disabled &&
        event.code === "Slash" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        onRunModeChange(isResearch ? "chat" : "research")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [disabled, isResearch, onRunModeChange])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-pressed={isResearch}
          className={cn(
            "px-2 font-normal text-muted-foreground hover:bg-accent focus-visible:border-transparent focus-visible:ring-0",
            isResearch &&
              "bg-accent text-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground"
          )}
          onClick={() => {
            onRunModeChange(isResearch ? "chat" : "research")
          }}
        >
          <Telescope className="size-3.5" />
          <span>Research</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" shortcut="⌘/">
        Deep Research
      </TooltipContent>
    </Tooltip>
  )
}
