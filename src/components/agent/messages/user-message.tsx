import { CornerRightUp, FileText, ImageIcon, Loader2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { useModels } from "@/hooks/agent/use-models"
import {
  type AgentAttachmentMetadata,
  type AgentRunMode,
  AvailableModels,
  getModelSelectorModels,
  isModelSelectorModel,
  type Message,
  type ModelType,
  resolveDefaultModelSelectorModel,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { Button } from "../../ui/button"
import { Textarea } from "../../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { ModelSelector } from "../prompt-form/model-selector"
import { ResearchModeToggle } from "../prompt-form/research-mode-toggle"
import {
  agentShellFrameClass,
  agentShellHighlightClass,
  agentShellInteractiveClass,
  agentSurfaceBackgroundClass,
  agentSurfaceClass,
} from "../shared/shell-styles"

const MAX_CONTENT_HEIGHT = 128

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${String(sizeBytes)} B`
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function isModelType(value: unknown): value is ModelType {
  return (
    typeof value === "string" &&
    Object.values(AvailableModels).includes(value as ModelType)
  )
}

function UserAttachmentChip({
  attachment,
}: {
  attachment: AgentAttachmentMetadata
}) {
  return (
    <div
      className={cn(
        agentShellFrameClass,
        "user-message-border max-w-72 shrink-0"
      )}
    >
      <div
        className={cn(
          agentSurfaceClass,
          "flex h-10 min-w-0 items-center gap-2 px-2 text-xs"
        )}
      >
        <div className={agentSurfaceBackgroundClass} />
        <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground">
          {attachment.kind === "image" ? (
            attachment.previewDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachment.previewDataUrl}
                alt=""
                className="size-full object-cover"
              />
            ) : (
              <ImageIcon className="size-3.5" />
            )
          ) : (
            <FileText className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-foreground">{attachment.filename}</div>
          <div className="text-muted-foreground">
            {formatFileSize(attachment.sizeBytes)}
          </div>
        </div>
      </div>
    </div>
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
    newRunMode: AgentRunMode
  }) => Promise<void> | void
}) {
  const { data: availableModels = [] } = useModels()
  const modelSelectorModels = useMemo(
    () => getModelSelectorModels(availableModels),
    [availableModels]
  )
  const initialModel = useMemo(() => {
    const selectedModel = message.metadata?.selectedModel
    if (isModelType(selectedModel) && isModelSelectorModel(selectedModel)) {
      return selectedModel
    }

    if (isModelType(message.llmModel) && isModelSelectorModel(message.llmModel)) {
      return message.llmModel
    }

    return resolveDefaultModelSelectorModel(modelSelectorModels)
  }, [message.llmModel, message.metadata?.selectedModel, modelSelectorModels])

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(message.content)
  const [selectedModel, setSelectedModel] = useState<ModelType>(initialModel)
  const initialRunMode = message.metadata?.runMode ?? "chat"
  const [runMode, setRunMode] = useState<AgentRunMode>(initialRunMode)
  const [isEditPending, setIsEditPending] = useState(false)
  const messageContentRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isContentOverflowing, setIsContentOverflowing] = useState(false)
  const attachments = message.metadata?.attachments ?? []

  useEffect(() => {
    setEditValue(message.content)
  }, [message.content])

  useEffect(() => {
    setSelectedModel(initialModel)
  }, [initialModel])

  useEffect(() => {
    setRunMode(initialRunMode)
  }, [initialRunMode])

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
    setRunMode(initialRunMode)
  }, [message.content, initialModel, initialRunMode])

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
        newRunMode: runMode,
      })
      setIsEditing(false)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to edit message"
      toast.error(errorMessage)
    } finally {
      setIsEditPending(false)
    }
  }, [
    editValue,
    handleStopEditing,
    message.id,
    onEditMessage,
    runMode,
    selectedModel,
  ])

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
        "group/user-message ml-auto flex max-w-[95%] flex-col items-end gap-2 self-end text-start",
        isFirstMessage ? "mt-2" : "",
        className
      )}
    >
      {isEditing ? (
        <div
          className={cn(
            "w-full",
            agentShellFrameClass,
            agentShellInteractiveClass,
            agentShellHighlightClass
          )}
        >
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
                <ResearchModeToggle
                  runMode={runMode}
                  onRunModeChange={setRunMode}
                  disabled={isEditPending}
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
        </div>
      ) : (
        <>
          {attachments.length > 0 ? (
            <div className="flex max-w-full flex-wrap justify-end gap-2">
              {attachments.map((attachment) => (
                <UserAttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                />
              ))}
            </div>
          ) : null}

          <div
            className={cn(
              "max-w-full",
              agentShellFrameClass,
              agentShellInteractiveClass,
              agentShellHighlightClass,
              !disableEditing && "cursor-pointer"
            )}
            role="button"
            tabIndex={disableEditing || isEditPending ? -1 : 0}
            onClick={() => {
              if (!disableEditing) {
                setIsEditing(true)
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !disableEditing) {
                e.preventDefault()
                setIsEditing(true)
              }
            }}
          >
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
              <div ref={messageContentRef} className="whitespace-pre-wrap">
                {message.content}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
