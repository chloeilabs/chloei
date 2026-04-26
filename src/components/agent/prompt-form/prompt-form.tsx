"use client"

import "../messages/messages.css"

import { CornerRightUp, Loader2, Square } from "lucide-react"
import {
  type CSSProperties,
  type TransitionStartFunction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { RefreshGlow } from "@/components/graphics/effects/refresh-glow"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useModels } from "@/hooks/agent/use-models"
import { usePersistentSelectedModel } from "@/hooks/agent/use-persistent-selected-model"
import {
  type AgentRunMode,
  getModelSelectorModels,
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
import { ResearchModeToggle } from "./research-mode-toggle"

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
    runMode: AgentRunMode
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
  const [runMode, setRunMode] = useState<AgentRunMode>("chat")
  const trimmedMessage = useMemo(() => message.trim(), [message])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  const handleSelectModel = useCallback(
    (model: ModelType | null) => {
      setSelectedModel(model)
    },
    [setSelectedModel]
  )

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault()

      const nextMessage = message.trim()

      if (isStreaming && !nextMessage) {
        onStopStream?.()
        return
      }

      if (!nextMessage || !resolvedSelectedModel || isFormPending) {
        return
      }

      if (dismissKeyboardOnSubmit) {
        textareaRef.current?.blur()

        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      }

      const activeRunMode = runMode
      onSubmit?.(nextMessage, resolvedSelectedModel, isStreaming, activeRunMode)
      setMessage("")
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

  const isSubmitButtonDisabled =
    isFormPending || !resolvedSelectedModel || (!isStreaming && !trimmedMessage)

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
        className={cn(
          agentShellFrameClass,
          agentShellInteractiveClass,
          agentShellHighlightClass,
          isFormPending && "opacity-50"
        )}
      >
        <div className={cn(agentSurfaceClass, "flex min-h-24 flex-col")}>
          <div className={agentSurfaceBackgroundClass} />
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
              <ModelSelector
                selectedModel={resolvedSelectedModel}
                handleSelectModel={handleSelectModel}
              />
              <ResearchModeToggle
                runMode={runMode}
                onRunModeChange={setRunMode}
                disabled={isFormPending}
              />
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
                ) : isStreaming && !trimmedMessage ? (
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
