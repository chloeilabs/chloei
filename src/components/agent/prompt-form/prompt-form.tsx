"use client"

import {
  CornerRightUpIcon,
  FileText,
  Loader2,
  Plus,
  Square,
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

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useModels } from "@/hooks/agent/use-models"
import { usePersistentSelectedModel } from "@/hooks/agent/use-persistent-selected-model"
import {
  getModelSelectorModels,
  type MessageAttachment,
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { QueuedAction } from "../messages/queued-message"
import {
  ACCEPTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  readAttachmentFile,
} from "./attachments"

interface QueuedPromptSubmission {
  message: string
  model: ModelType
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
  queuedSubmission,
  onClearQueuedMessage,
  isPendingOverride,
  transition,
  viewTransitionName,
  seedMessage,
}: {
  onSubmit?: (
    message: string,
    model: ModelType,
    queue: boolean,
    attachments: MessageAttachment[]
  ) => void
  onStopStream?: () => void
  isStreaming?: boolean
  isHome?: boolean
  dismissKeyboardOnSubmit?: boolean
  onFocus?: () => void
  onBlur?: () => void
  initialSelectedModel?: ModelType | null
  dockToBottomOnHome?: boolean
  queuedSubmission?: QueuedPromptSubmission | null
  onClearQueuedMessage?: () => void
  isPendingOverride?: boolean
  transition?: {
    isPending: boolean
    startTransition: TransitionStartFunction
  }
  viewTransitionName?: string
  seedMessage?: { id: number; text: string } | null
}) {
  const isPending = transition?.isPending
  const isFormPending = isPendingOverride ?? isPending ?? false
  const shouldDockPrompt = !isHome || dockToBottomOnHome

  const [message, setMessage] = useState("")
  const trimmedMessage = useMemo(() => message.trim(), [message])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!seedMessage) {
      return
    }

    setMessage(seedMessage.text)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) {
        return
      }
      textarea.focus()
      const cursor = textarea.value.length
      textarea.setSelectionRange(cursor, cursor)
    })
  }, [seedMessage])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const attachmentsRef = useRef<MessageAttachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return
    }

    const accepted: MessageAttachment[] = []
    const errors: string[] = []
    let remaining = MAX_ATTACHMENTS - attachmentsRef.current.length

    for (const file of files) {
      if (remaining <= 0) {
        errors.push(
          `${file.name}: up to ${String(MAX_ATTACHMENTS)} files allowed`
        )
        continue
      }

      const result = await readAttachmentFile(file)
      if (result.attachment) {
        accepted.push(result.attachment)
        remaining -= 1
      } else if (result.error) {
        errors.push(result.error)
      }
    }

    if (accepted.length > 0) {
      setAttachments((previous) =>
        [...previous, ...accepted].slice(0, MAX_ATTACHMENTS)
      )
    }

    for (const error of errors) {
      toast.error("Attachment skipped", { description: error })
    }
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) =>
      previous.filter((attachment) => attachment.id !== id)
    )
  }, [])

  const { data: availableModels } = useModels()
  const modelSelectorModels = useMemo(
    () => getModelSelectorModels(availableModels),
    [availableModels]
  )
  const { selectedModel } = usePersistentSelectedModel(
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

  const restoreQueuedSubmission = useCallback(() => {
    if (!queuedSubmission) {
      return
    }

    setMessage(queuedSubmission.message)
    onClearQueuedMessage?.()

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) {
        return
      }

      textarea.focus()
      const cursorPosition = textarea.value.length
      textarea.setSelectionRange(cursorPosition, cursorPosition)
      textarea.scrollTop = textarea.scrollHeight
    })
  }, [onClearQueuedMessage, queuedSubmission])

  const submitPrompt = useCallback(() => {
    const nextMessage = message.trim()
    const nextAttachments = attachments
    const composerEmpty = !nextMessage && nextAttachments.length === 0

    if (isStreaming && composerEmpty) {
      onStopStream?.()
      return true
    }

    if (composerEmpty || !resolvedSelectedModel || isFormPending) {
      return false
    }

    if (dismissKeyboardOnSubmit) {
      textareaRef.current?.blur()

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    }

    onSubmit?.(nextMessage, resolvedSelectedModel, isStreaming, nextAttachments)
    setMessage("")
    setAttachments([])

    return true
  }, [
    attachments,
    dismissKeyboardOnSubmit,
    isFormPending,
    isStreaming,
    message,
    onStopStream,
    onSubmit,
    resolvedSelectedModel,
  ])

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault()
      void submitPrompt()
    },
    [submitPrompt]
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

  // Fade the textarea text where there is more content to scroll towards, so a
  // long prompt softly dissolves into the composer at the top and/or bottom
  // edge instead of being cut off hard.
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false })

  const syncTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    // Reset then grow to content so the shell expands with the text instead of
    // jumping between discrete row counts.
    textarea.style.height = "auto"
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 40), 192)
    textarea.style.height = `${String(nextHeight)}px`
  }, [])

  const syncScrollFades = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    const { scrollTop, scrollHeight, clientHeight } = textarea
    const top = scrollTop > 1
    const bottom = scrollTop + clientHeight < scrollHeight - 1

    setScrollFade((previous) =>
      previous.top === top && previous.bottom === bottom
        ? previous
        : { top, bottom }
    )
  }, [])

  useEffect(() => {
    syncTextareaHeight()
    syncScrollFades()
  }, [message, attachments.length, syncScrollFades, syncTextareaHeight])

  useEffect(() => {
    const handleResize = () => {
      syncTextareaHeight()
      syncScrollFades()
    }
    window.addEventListener("resize", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
    }
  }, [syncScrollFades, syncTextareaHeight])

  const textareaMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!scrollFade.top && !scrollFade.bottom) {
      return undefined
    }

    const fade = "1.5rem"
    const stops = [
      scrollFade.top ? `transparent 0, #000 ${fade}` : "#000 0",
      scrollFade.bottom
        ? `#000 calc(100% - ${fade}), transparent 100%`
        : "#000 100%",
    ].join(", ")
    const maskImage = `linear-gradient(to bottom, ${stops})`

    return {
      maskImage,
      WebkitMaskImage: maskImage,
    }
  }, [scrollFade.top, scrollFade.bottom])

  const isComposerEmpty = !trimmedMessage && attachments.length === 0
  const isSubmitButtonDisabled =
    isFormPending || !resolvedSelectedModel || (!isStreaming && isComposerEmpty)

  return (
    <form
      data-prompt-form
      onSubmit={handleSubmit}
      style={formStyle}
      className={cn(
        "relative isolate z-0 flex w-full flex-col",
        shouldDockPrompt && "sticky bottom-0 bg-background py-4"
      )}
    >
      {shouldDockPrompt ? (
        <div className="pointer-events-none absolute inset-x-0 -top-[calc(4rem-1px)] -z-10 h-16 -translate-y-px bg-gradient-to-t from-background via-background/45 to-transparent" />
      ) : null}

      {queuedSubmission && onClearQueuedMessage && (
        <QueuedAction
          message={queuedSubmission.message}
          onClear={onClearQueuedMessage}
          onRestore={restoreQueuedSubmission}
        />
      )}

      <div
        className={cn(
          // 26px is half of the 52px shell — reads as a full pill on one line,
          // and keeps the same soft corners when attachments / multiline grow it
          // (avoids the jarring rounded-full ↔ radius morph).
          "flex min-h-[52px] flex-col rounded-[26px] border border-white/5 bg-[#212121] transition-opacity",
          "focus-within:border-white/5 focus-within:ring-0",
          isFormPending && "opacity-50"
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3 duration-200 animate-in fade-in slide-in-from-top-1">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pr-2 pl-1"
              >
                {attachment.kind === "image" && attachment.url ? (
                  <span
                    className="size-9 shrink-0 rounded-full bg-cover bg-center"
                    style={{ backgroundImage: `url(${attachment.url})` }}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-[#afafaf]">
                    <FileText className="size-4" aria-hidden="true" />
                  </span>
                )}
                <span className="max-w-32 truncate text-xs text-white/80">
                  {attachment.name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeAttachment(attachment.id)
                  }}
                  aria-label={`Remove ${attachment.name}`}
                  className="rounded-full p-0.5 text-[#afafaf] transition-colors hover:text-white"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1 p-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_ATTACHMENT_TYPES}
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ""
              void addFiles(files)
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={isFormPending || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => {
              fileInputRef.current?.click()
            }}
            aria-label="Attach images or PDFs"
            className="size-[40px] shrink-0 rounded-full text-white transition-colors hover:bg-[#383838] hover:text-white dark:hover:bg-[#383838]"
          >
            <Plus className="size-[22px]" strokeWidth={1.75} />
          </Button>

          <Textarea
            ref={textareaRef}
            value={message}
            rows={1}
            onChange={(e) => {
              if (!isFormPending) {
                setMessage(e.target.value)
              }
            }}
            onKeyDown={onKeyDown}
            onScroll={syncScrollFades}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder="Ask anything"
            style={textareaMaskStyle}
            className="no-scrollbar max-h-48 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent! px-1 py-2 shadow-none placeholder:text-[#afafaf] focus-visible:ring-0 md:text-base"
          />

          <Button
            type="submit"
            size="icon"
            disabled={isSubmitButtonDisabled}
            aria-label={
              isFormPending
                ? "Sending message"
                : isStreaming && isComposerEmpty
                  ? "Stop response"
                  : "Send message"
            }
            className="size-[40px] shrink-0 rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {isFormPending ? (
              <Loader2 className="size-5 animate-spin" />
            ) : isStreaming && isComposerEmpty ? (
              <Square className="size-[15px] fill-current" />
            ) : (
              <CornerRightUpIcon className="size-5" />
            )}
          </Button>
        </div>
      </div>

      {!resolvedSelectedModel && (
        <p className="mt-2 text-xs text-[#afafaf]">
          Configure `OPENAI_API_KEY` on the server to enable model access.
        </p>
      )}
    </form>
  )
}
