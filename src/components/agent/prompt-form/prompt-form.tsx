"use client"

import "../messages/messages.css"

import {
  CornerRightUp,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Square,
  Telescope,
  X,
} from "lucide-react"
import {
  type CSSProperties,
  type TransitionStartFunction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import { RefreshGlow } from "@/components/graphics/effects/refresh-glow"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { useModels } from "@/hooks/agent/use-models"
import { usePersistentSelectedModel } from "@/hooks/agent/use-persistent-selected-model"
import {
  AGENT_ATTACHMENT_MAX_FILE_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  type AgentAttachmentMimeType,
  type AgentRequestAttachment,
  type AgentRunMode,
  getAgentAttachmentAcceptAttribute,
  getAgentAttachmentKind,
  getModelSelectorModels,
  isSupportedAgentAttachmentMimeType,
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { QueuedAction } from "../messages/queued-message"
import {
  agentShellFrameClass,
  agentShellHighlightClass,
  agentShellInteractiveClass,
  agentSurfaceBackgroundClass,
  agentSurfaceClass,
} from "../shared/shell-styles"
import { ModelSelector } from "./model-selector"

const DEFAULT_ATTACHMENT_PROMPT = "Analyze the attached file(s)."
const IMAGE_PREVIEW_MAX_EDGE = 160

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${String(sizeBytes)} B`
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result === "string") {
        resolve(result)
        return
      }

      reject(new Error("File could not be read."))
    }
    reader.onerror = () => {
      reject(new Error("File could not be read."))
    }
    reader.readAsDataURL(file)
  })
}

async function createImagePreviewDataUrl(
  dataUrl: string
): Promise<string | undefined> {
  if (typeof window === "undefined") {
    return undefined
  }

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new window.Image()
      nextImage.onload = () => {
        resolve(nextImage)
      }
      nextImage.onerror = () => {
        reject(new Error("Image preview failed."))
      }
      nextImage.src = dataUrl
    })
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight)
    if (!longestEdge) {
      return undefined
    }

    const scale = Math.min(1, IMAGE_PREVIEW_MAX_EDGE / longestEdge)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) {
      return undefined
    }

    context.drawImage(image, 0, 0, width, height)
    const previewDataUrl = canvas.toDataURL("image/jpeg", 0.72)
    return previewDataUrl.length <= AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS
      ? previewDataUrl
      : undefined
  } catch {
    return undefined
  }
}

function getNormalizedFileMediaType(file: File): AgentAttachmentMimeType | null {
  const mediaType = file.type.toLowerCase()
  return isSupportedAgentAttachmentMimeType(mediaType) ? mediaType : null
}

export function PromptForm({
  onSubmit,
  onStopStream,
  isStreaming = false,
  isHome = false,
  dismissKeyboardOnSubmit = false,
  onFocus,
  onBlur,
  initialSelectedModel,
  dockToBottomOnHome = false,
  queuedMessage,
  onClearQueuedMessage,
  isPendingOverride,
  transition,
  viewTransitionName,
}: {
  onSubmit?: (
    message: string,
    model: ModelType,
    queue: boolean,
    runMode: AgentRunMode,
    attachments: AgentRequestAttachment[]
  ) => void
  onStopStream?: () => void
  isStreaming?: boolean
  isHome?: boolean
  dismissKeyboardOnSubmit?: boolean
  onFocus?: () => void
  onBlur?: () => void
  initialSelectedModel?: ModelType | null
  dockToBottomOnHome?: boolean
  queuedMessage?: string | null
  onClearQueuedMessage?: () => void
  isPendingOverride?: boolean
  transition?: {
    isPending: boolean
    startTransition: TransitionStartFunction
  }
  viewTransitionName?: string
}) {
  const isPending = transition?.isPending
  const isFormPending = isPendingOverride ?? isPending ?? false
  const shouldDockPrompt = !isHome || dockToBottomOnHome
  const shouldShowRefreshAnimation = isHome && !dockToBottomOnHome

  const [message, setMessage] = useState("")
  const [pendingAttachments, setPendingAttachments] = useState<
    AgentRequestAttachment[]
  >([])
  const [isDragActive, setIsDragActive] = useState(false)
  const [isToolsOpen, setIsToolsOpen] = useState(false)
  const [runMode, setRunMode] = useState<AgentRunMode>("chat")
  const trimmedMessage = useMemo(() => message.trim(), [message])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const shouldPreventToolsCloseAutoFocusRef = useRef(false)
  const attachmentAccept = useMemo(() => getAgentAttachmentAcceptAttribute(), [])
  const pendingAttachmentBytes = useMemo(
    () =>
      pendingAttachments.reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0
      ),
    [pendingAttachments]
  )

  const { data: availableModels = [] } = useModels()
  const modelSelectorModels = useMemo(
    () => getModelSelectorModels(availableModels),
    [availableModels]
  )
  const { selectedModel, setSelectedModel } = usePersistentSelectedModel(
    initialSelectedModel,
    modelSelectorModels
  )
  const formStyle = useMemo<CSSProperties | undefined>(
    () =>
      viewTransitionName
        ? {
            viewTransitionName,
          }
        : undefined,
    [viewTransitionName]
  )

  const resolvedSelectedModel = selectedModel
  const isResearchMode = runMode === "research"

  const handleSelectModel = useCallback(
    (model: ModelType | null) => {
      setSelectedModel(model)
    },
    [setSelectedModel]
  )

  const removeAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    )
  }, [])

  const clearFileInput = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [])

  const handleAttachClick = useCallback(() => {
    if (isFormPending) {
      return
    }

    shouldPreventToolsCloseAutoFocusRef.current = true
    setIsToolsOpen(false)
    fileInputRef.current?.click()
  }, [isFormPending])

  const handleToggleResearch = useCallback(() => {
    if (isFormPending) {
      return
    }

    shouldPreventToolsCloseAutoFocusRef.current = true
    setRunMode((currentRunMode) =>
      currentRunMode === "research" ? "chat" : "research"
    )
    setIsToolsOpen(false)
  }, [isFormPending])

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (isFormPending) {
        return
      }

      const fileArray = Array.from(files)
      if (fileArray.length === 0) {
        return
      }

      const nextAttachments: AgentRequestAttachment[] = []
      let nextCount = pendingAttachments.length
      let nextTotalBytes = pendingAttachmentBytes

      for (const file of fileArray) {
        if (nextCount >= AGENT_ATTACHMENT_MAX_FILES) {
          toast.error("Too many attachments", {
            description: `Attach up to ${String(AGENT_ATTACHMENT_MAX_FILES)} files per request.`,
          })
          break
        }

        const mediaType = getNormalizedFileMediaType(file)
        if (!mediaType) {
          toast.error("Unsupported file type", {
            description: "Attach a PDF, PNG, JPEG, WEBP, or non-animated GIF.",
          })
          continue
        }

        if (file.size <= 0) {
          toast.error("Empty file", {
            description: `${file.name || "This file"} has no content.`,
          })
          continue
        }

        if (file.size > AGENT_ATTACHMENT_MAX_FILE_BYTES) {
          toast.error("File too large", {
            description: `${file.name || "This file"} must be ${formatFileSize(AGENT_ATTACHMENT_MAX_FILE_BYTES)} or smaller.`,
          })
          continue
        }

        if (nextTotalBytes + file.size > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
          toast.error("Attachments too large", {
            description: `Keep all attachments under ${formatFileSize(AGENT_ATTACHMENT_MAX_TOTAL_BYTES)} per request.`,
          })
          break
        }

        try {
          const dataUrl = await readFileAsDataUrl(file)
          const kind = getAgentAttachmentKind(mediaType)
          const previewDataUrl =
            kind === "image" ? await createImagePreviewDataUrl(dataUrl) : undefined
          nextAttachments.push({
            id: crypto.randomUUID(),
            kind,
            filename: file.name || "attachment",
            mediaType,
            sizeBytes: file.size,
            ...(kind === "image" ? { detail: "auto" } : {}),
            ...(previewDataUrl ? { previewDataUrl } : {}),
            dataUrl,
          })
          nextCount += 1
          nextTotalBytes += file.size
        } catch {
          toast.error("File could not be read", {
            description: file.name || "Please try another file.",
          })
        }
      }

      if (nextAttachments.length > 0) {
        setPendingAttachments((current) => [...current, ...nextAttachments])
      }
      clearFileInput()
    },
    [
      clearFileInput,
      isFormPending,
      pendingAttachmentBytes,
      pendingAttachments.length,
    ]
  )

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault()

      const nextMessage = message.trim()
      const nextAttachments = pendingAttachments

      if (isStreaming && !nextMessage && nextAttachments.length === 0) {
        onStopStream?.()
        return
      }

      if (
        (!nextMessage && nextAttachments.length === 0) ||
        !resolvedSelectedModel ||
        isFormPending
      ) {
        return
      }

      if (dismissKeyboardOnSubmit) {
        textareaRef.current?.blur()

        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      }

      const activeRunMode = runMode
      onSubmit?.(
        nextMessage || DEFAULT_ATTACHMENT_PROMPT,
        resolvedSelectedModel,
        isStreaming,
        activeRunMode,
        nextAttachments
      )
      setMessage("")
      setPendingAttachments([])
      clearFileInput()
      if (activeRunMode === "research") {
        setRunMode("chat")
      }
    },
    [
      dismissKeyboardOnSubmit,
      isStreaming,
      message,
      onStopStream,
      resolvedSelectedModel,
      runMode,
      isFormPending,
      onSubmit,
      pendingAttachments,
      clearFileInput,
    ]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey) {
        return
      }

      e.preventDefault()
      handleSubmit(e)
    },
    [handleSubmit]
  )

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (isStreaming) {
          onStopStream?.()
        }
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown)
    }
  }, [isStreaming, onStopStream])

  useEffect(() => {
    const handleAttachmentShortcut = (event: KeyboardEvent) => {
      if (
        !isFormPending &&
        event.code === "Semicolon" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        handleAttachClick()
      }
    }

    window.addEventListener("keydown", handleAttachmentShortcut)
    return () => {
      window.removeEventListener("keydown", handleAttachmentShortcut)
    }
  }, [handleAttachClick, isFormPending])

  useEffect(() => {
    const handleResearchShortcut = (event: KeyboardEvent) => {
      if (
        !isFormPending &&
        event.code === "Slash" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        setRunMode((currentRunMode) =>
          currentRunMode === "research" ? "chat" : "research"
        )
      }
    }

    window.addEventListener("keydown", handleResearchShortcut)
    return () => {
      window.removeEventListener("keydown", handleResearchShortcut)
    }
  }, [isFormPending])

  const isSubmitButtonDisabled =
    isFormPending ||
    !resolvedSelectedModel ||
    (!isStreaming && !trimmedMessage && pendingAttachments.length === 0)

  return (
    <form
      data-prompt-form
      onSubmit={handleSubmit}
      style={formStyle}
      className={cn(
        "relative isolate z-0 flex w-full flex-col",
        shouldDockPrompt && "sticky bottom-0 bg-background pb-4"
      )}
    >
      {shouldShowRefreshAnimation ? (
        <RefreshGlow className="pointer-events-none -top-24 left-1/2 z-0 h-[calc(100svh-18rem)] w-screen max-w-5xl -translate-x-1/2" />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 -top-[calc(4rem-1px)] -z-10 h-16 -translate-y-px bg-gradient-to-t from-background via-background/45 to-transparent" />

      {queuedMessage && onClearQueuedMessage && (
        <QueuedAction message={queuedMessage} onClear={onClearQueuedMessage} />
      )}

      <div
        onDragOver={(event) => {
          if (isFormPending) {
            return
          }
          event.preventDefault()
          setIsDragActive(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setIsDragActive(false)
          }
        }}
        onDrop={(event) => {
          if (isFormPending) {
            return
          }
          event.preventDefault()
          setIsDragActive(false)
          void handleFiles(event.dataTransfer.files)
        }}
        className={cn(
          agentShellFrameClass,
          agentShellInteractiveClass,
          agentShellHighlightClass,
          isDragActive && "ring-1 ring-ring/70",
          isFormPending && "opacity-50"
        )}
      >
        <div className={cn(agentSurfaceClass, "flex min-h-24 flex-col")}>
          <div className={agentSurfaceBackgroundClass} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={attachmentAccept}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              void handleFiles(event.target.files ?? [])
            }}
          />

          {pendingAttachments.length > 0 ? (
            <div className="relative z-10 flex flex-wrap gap-2 px-2 pt-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex h-9 max-w-64 min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-1.5 text-xs"
                >
                  <div className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-muted-foreground">
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
                    <div className="truncate text-foreground">
                      {attachment.filename}
                    </div>
                    <div className="text-muted-foreground">
                      {formatFileSize(attachment.sizeBytes)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="iconXs"
                    disabled={isFormPending}
                    className="ml-auto shrink-0 p-0 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() => {
                      removeAttachment(attachment.id)
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              if (!isFormPending) {
                setMessage(e.target.value)
              }
            }}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder="Ask anything"
            className="max-h-48 flex-1 resize-none border-0 bg-transparent! shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />

          <div className="grid grid-cols-2 items-center px-2 py-2">
            <div className="flex min-w-0 items-center justify-start gap-1">
              <Popover
                open={isToolsOpen}
                onOpenChange={(open) => {
                  if (!isFormPending) {
                    setIsToolsOpen(open)
                  }
                }}
              >
                <PopoverTrigger asChild aria-controls={undefined}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="iconSm"
                    disabled={isFormPending}
                    aria-label="Tools"
                    className="shrink-0 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                  >
                    <Plus className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  sideOffset={2}
                  onCloseAutoFocus={(event) => {
                    if (!shouldPreventToolsCloseAutoFocusRef.current) {
                      return
                    }

                    event.preventDefault()
                    shouldPreventToolsCloseAutoFocusRef.current = false
                    textareaRef.current?.focus({ preventScroll: true })
                  }}
                  className="flex w-56 flex-col gap-0.5 rounded-none p-1.5"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isFormPending}
                    className="w-full justify-start px-2 font-normal text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0"
                    onClick={handleAttachClick}
                  >
                    <Paperclip className="size-3.5" />
                    <span>Attach PDF or image</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      ⌘;
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isFormPending}
                    aria-pressed={isResearchMode}
                    className={cn(
                      "w-full justify-start px-2 font-normal text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0",
                      isResearchMode &&
                        "bg-accent text-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground"
                    )}
                    onClick={handleToggleResearch}
                  >
                    <Telescope className="size-3.5" />
                    <span>Research</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      ⌘/
                    </span>
                  </Button>
                </PopoverContent>
              </Popover>
              {isResearchMode ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isFormPending}
                  aria-pressed="true"
                  className="bg-accent px-2 font-normal text-foreground hover:bg-accent focus-visible:border-transparent focus-visible:ring-0"
                  onClick={handleToggleResearch}
                >
                  <Telescope className="size-3.5" />
                  <span>Research</span>
                </Button>
              ) : (
                <ModelSelector
                  selectedModel={resolvedSelectedModel}
                  handleSelectModel={handleSelectModel}
                />
              )}
            </div>

            <div className="flex min-w-0 items-center justify-end gap-[8px]">
              <Button
                type="submit"
                size="iconSm"
                disabled={isSubmitButtonDisabled}
                className="shrink-0 ring-offset-background"
              >
                {isFormPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isStreaming &&
                  !trimmedMessage &&
                  pendingAttachments.length === 0 ? (
                  <div className="p-0.5">
                    <Square className="size-3 fill-primary-foreground" />
                  </div>
                ) : (
                  <CornerRightUp className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {!resolvedSelectedModel && (
        <p className="mt-2 text-xs text-muted-foreground">
          Configure `AI_GATEWAY_API_KEY` on the server to enable model access.
        </p>
      )}
    </form>
  )
}
