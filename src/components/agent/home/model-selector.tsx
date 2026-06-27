"use client"

import { ChevronDown } from "lucide-react"
import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useModels } from "@/hooks/agent/use-models"
import { usePersistentSelectedModel } from "@/hooks/agent/use-persistent-selected-model"
import { getModelSelectorModels, type ModelType } from "@/lib/shared"

export function ModelSelector({
  initialSelectedModel,
}: {
  initialSelectedModel?: ModelType | null
}) {
  const { data: availableModels } = useModels()
  const modelSelectorModels = useMemo(
    () => getModelSelectorModels(availableModels),
    [availableModels]
  )
  const { selectedModel, setSelectedModel } = usePersistentSelectedModel(
    initialSelectedModel,
    modelSelectorModels
  )

  if (modelSelectorModels.length === 0) {
    return null
  }

  const activeModel =
    modelSelectorModels.find((model) => model.id === selectedModel) ??
    modelSelectorModels[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="pointer-events-auto -ml-2 gap-1 font-medium text-muted-foreground hover:text-foreground"
          aria-label="Select model"
        >
          {activeModel?.name ?? "Model"}
          <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup
          value={selectedModel ?? undefined}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setSelectedModel(value as ModelType)
            }
          }}
        >
          {modelSelectorModels.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id}>
              {model.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
