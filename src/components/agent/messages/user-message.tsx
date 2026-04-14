import { CornerRightUp, Loader2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { useModels } from "@/hooks/agent/use-models"
import {
  AvailableModels,
  type Message,
  type ModelType,
  resolveDefaultModel,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { Button } from "../../ui/button"
import { Textarea } from "../../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { ModelSelector } from "../prompt-form/model-selector"
import {
  agentShellFrameClass,
  agentShellHighlightClass,
  agentShellInteractiveClass,
  agentSurfaceBackgroundClass,
  agentSurfaceClass,
} from "../shared/shell-styles"

const MAX_CONTENT_HEIGHT = 128

function isModelType(value: unknown): value is ModelType {
  return (
    typeof value === "string" &&
    Object.values(AvailableModels).includes(value as ModelType)
  )
}

export function UserMessage({
  message,
  className,
  isFirstMessage,
  disableEditing,
  onEditMessage,
}: {
  message: Message
  isFirstMessage: boolean
  className?: string
  disableEditing: boolean
  onEditMessage?: (params: {
    messageId: string
    newContent: string
    newModel: ModelType
  }) => Promise<void> | void
}) {
  const { data: availableModels = [] } = useModels()
  const initialModel = useMemo(() => {
    const selectedModel = message.metadata?.selectedModel
    if (isModelType(selectedModel)) {
      return selectedModel
    }

    if (isModelType(message.llmModel)) {
      return message.llmModel
    }

    return resolveDefaultModel(availableModels)
  }, [availableModels, message.llmModel, message.metadata?.selectedModel])

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(message.content)
  const [selectedModel, setSelectedModel] = useState<ModelType>(initialModel)
  const [isEditPending, setIsEditPending] = useState(false)
  const messageContentRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isContentOverflowing, setIsContentOverflowing] = useState(false)

  useEffect(() => {
    setEditValue(message.content)
  }, [message.content])

  useEffect(() => {
    setSelectedModel(initialModel)
  }, [initialModel])

  useEffect(() => {
    if (messageContentRef.current) {
      setIsContentOverflowing(
        messageContentRef.current.scrollHeight > MAX_CONTENT_HEIGHT
      )
    }
  }, [message.content])

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const textarea = textareaRef.current
      const length = textarea.value.length
      textarea.setSelectionRange(length, length)
      textarea.scrollTop = textarea.scrollHeight
    }
  }, [isEditing])

  const handleSelectModel = useCallback((model: ModelType | null) => {
    if (model) {
      setSelectedModel(model)
    }
  }, [])

  const handleStopEditing = useCallback(() => {
    setIsEditing(false)
    setEditValue(message.content)
    setSelectedModel(initialModel)
  }, [message.content, initialModel])

  const handleSubmit = useCallback(async () => {
    const trimmedValue = editValue.trim()
    if (!trimmedValue) {
      handleStopEditing()
      return
    }

    if (!onEditMessage) {
      handleStopEditing()
      return
    }

    setIsEditPending(true)

    try {
      await onEditMessage({
        messageId: message.id,
        newContent: trimmedValue,
        newModel: selectedModel,
      })
      setIsEditing(false)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to edit message"
      toast.error(errorMessage)
    } finally {
      setIsEditPending(false)
    }
  }, [editValue, handleStopEditing, message.id, onEditMessage, selectedModel])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit]
  )

  useEffect(() => {
    const globalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isEditing) {
        e.preventDefault()
        handleStopEditing()
      }
    }

    window.addEventListener("keydown", globalKeyDown)
    return () => {
      window.removeEventListener("keydown", globalKeyDown)
    }
  }, [isEditing, handleStopEditing])

  return (
    <div
      data-message-role="user"
      className={cn(
        "group/user-message ml-auto flex max-w-[95%] flex-col self-end text-start",
        agentShellFrameClass,
        agentShellInteractiveClass,
        agentShellHighlightClass,
        !isEditing && !disableEditing && "cursor-pointer",
        isFirstMessage ? "mt-2" : "",
        className
      )}
      role="button"
      tabIndex={disableEditing || isEditPending ? -1 : 0}
      onClick={() => {
        if (!isEditing && !disableEditing) {
          setIsEditing(true)
        }
      }}
      onKeyDown={(e) => {
        if (
          (e.key === "Enter" || e.key === " ") &&
          !isEditing &&
          !disableEditing
        ) {
          e.preventDefault()
          setIsEditing(true)
        }
      }}
    >
      {isEditing ? (
        <>
          <div className="overflow-clip select-none">
            <div className="flex flex-col gap-0.5 p-1.5">
              <div className="flex w-full items-center justify-between gap-1 pl-1.5 text-xs font-medium text-muted-foreground">
                <span>Editing Message</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="iconXs"
                      tabIndex={-1}
                      className="p-0 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                      onClick={handleStopEditing}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" sideOffset={10}>
                    Cancel Editing
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>

          <div className={cn(agentSurfaceClass, "flex min-h-24 flex-col")}>
            <div className={agentSurfaceBackgroundClass} />
            <Textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value)
              }}
              placeholder="Ask anything"
              className="max-h-48 flex-1 resize-none border-0 bg-transparent! text-base shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 md:text-sm"
              onKeyDown={onKeyDown}
            />

            <div className="grid grid-cols-2 items-center px-2 py-2">
              <div className="flex min-w-0 items-center justify-start gap-1">
                <ModelSelector
                  selectedModel={selectedModel}
                  handleSelectModel={handleSelectModel}
                />
              </div>

              <div className="flex min-w-0 items-center justify-end gap-[8px]">
                <Button
                  onClick={() => {
                    void handleSubmit()
                  }}
                  size="iconSm"
                  variant="default"
                  disabled={
                    !editValue.trim() || isEditPending || !selectedModel
                  }
                  className="shrink-0 ring-offset-background"
                >
                  {isEditPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CornerRightUp className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div
          className={cn(
            agentSurfaceClass,
            "w-full overflow-clip px-3 py-2 text-sm"
          )}
          style={{
            maxHeight: `${String(MAX_CONTENT_HEIGHT)}px`,
          }}
        >
          <div className={agentSurfaceBackgroundClass} />
          {isContentOverflowing && (
            <div className="absolute bottom-0 left-0 h-1/3 w-full animate-in bg-gradient-to-t from-background via-background/80 to-card/0 fade-in" />
          )}
          <div className="whitespace-pre-wrap" ref={messageContentRef}>
            {message.content}
          </div>
        </div>
      )}
    </div>
  )
}
