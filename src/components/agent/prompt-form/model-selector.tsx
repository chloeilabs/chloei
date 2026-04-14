import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useModels } from "@/hooks/agent/use-models"
import { ModelInfos, type ModelType } from "@/lib/shared"

export function ModelSelector({
  selectedModel,
  handleSelectModel,
}: {
  selectedModel: ModelType | null
  handleSelectModel: (model: ModelType | null) => void
}) {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)
  const shouldPreventCloseAutoFocusRef = useRef(false)

  const { data: availableModels = [] } = useModels()

  const handleModelSelection = (model: ModelType) => {
    shouldPreventCloseAutoFocusRef.current = true
    setIsModelSelectorOpen(false)
    handleSelectModel(model)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "." && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setIsModelSelectorOpen((prev) => !prev)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [])

  return (
    <Popover open={isModelSelectorOpen} onOpenChange={setIsModelSelectorOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild aria-controls={undefined}>
            <Button
              size="sm"
              variant="ghost"
              className="px-2 font-normal text-muted-foreground hover:bg-accent focus-visible:border-transparent focus-visible:ring-0"
            >
              <span>
                {selectedModel
                  ? ModelInfos[selectedModel].name
                  : "No Model Selected"}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!isModelSelectorOpen && (
          <TooltipContent side="top" align="start" shortcut="⌘.">
            Model Selector
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        align="start"
        onCloseAutoFocus={(event) => {
          if (!shouldPreventCloseAutoFocusRef.current) {
            return
          }

          event.preventDefault()
          shouldPreventCloseAutoFocusRef.current = false
        }}
        className="flex w-fit flex-col gap-0.5 overflow-hidden rounded-none p-0"
      >
        <div className="flex flex-col gap-0.5 rounded-none p-1.5">
          {availableModels.length > 0 ? (
            availableModels.map((model) => (
              <Button
                key={model.id}
                size="sm"
                variant="ghost"
                className="justify-start font-normal hover:bg-accent focus-visible:border-transparent focus-visible:ring-0"
                onClick={() => {
                  handleModelSelection(model.id)
                }}
              >
                <span>{ModelInfos[model.id].name}</span>
              </Button>
            ))
          ) : (
            <div className="p-2 text-left text-sm text-muted-foreground">
              No models available. Ask an admin to configure a provider API key
              on the server.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
