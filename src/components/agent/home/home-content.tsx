"use client"

import "../../graphics/logo/logo-animation.css"

import { History, SquarePen } from "lucide-react"
import Link from "next/link"
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { flushSync } from "react-dom"
import { StickToBottom } from "use-stick-to-bottom"

import { AppLauncher } from "@/components/agent/home/app-launcher"
import { UserMenu } from "@/components/auth/user-menu"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  type AgentRequestAttachment,
  type AgentRunMode,
  type AuthViewer,
  deriveThreadTitle,
  type ModelType,
  sortThreadsNewestFirst,
  type Thread,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { ChloeiLogoHoverSvg } from "../../graphics/logo/logo-hover-svg"
import { ChloeiLogoSvg } from "../../graphics/logo/logo-svg"
import { ScrollToBottom } from "../../task/scroll-to-bottom"
import { Messages } from "../messages/messages"
import { PromptForm } from "../prompt-form/prompt-form"
import { useAgentSession, useThreadStore } from "./use-agent-session"

type ViewTransitionStarter = (updateCallback: () => void) => unknown

const DEFAULT_FALLBACK_TRANSITION_MS = 150
const MOBILE_FALLBACK_TRANSITION_MS = 110
const STREAMING_SCROLL_EARLY_TRIGGER_PX = 72
const STREAMING_SCROLL_PROMPT_BUFFER_PX = 24
const conversationWidthClass = "max-w-[50rem]"

function ThreadsPanel({
  open,
  onClose,
  panelRef,
  threads,
  currentThreadId,
  setCurrentThreadId,
}: {
  open: boolean
  onClose: () => void
  panelRef: RefObject<HTMLDivElement | null>
  threads: Thread[]
  currentThreadId: string | null
  setCurrentThreadId: (threadId: string | null) => void
}) {
  const closePanel = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [closePanel, open])

  const sortedThreads = sortThreadsNewestFirst(threads)

  const handleSelectThread = (threadId: string) => {
    closePanel()
    setCurrentThreadId(threadId)
  }

  if (!open) {
    return null
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Threads"
      className="absolute top-14 right-3 z-30 flex max-h-[min(70vh,28rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-md border border-border bg-background p-2 shadow-[0_24px_80px_-40px_rgba(0,0,0,0.9)]"
    >
      {sortedThreads.length > 0 ? (
        <div className="space-y-1">
          {sortedThreads.map((thread) => {
            const title = deriveThreadTitle(thread.messages)

            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => {
                  handleSelectThread(thread.id)
                }}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center rounded-md border border-transparent px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:border-border/60 hover:bg-accent/30",
                  thread.id === currentThreadId &&
                    "border-border/70 bg-accent/40"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          No chat history yet.
        </div>
      )}
    </div>
  )
}

export function HomePageContent({
  initialSelectedModel,
  initialThreads = [],
  viewer,
}: {
  initialSelectedModel?: ModelType | null
  initialThreads?: Thread[]
  viewer: AuthViewer
}) {
  const [isPending, startTransition] = useTransition()
  const [isFallbackEnteringConversation, setIsFallbackEnteringConversation] =
    useState(false)
  const [isThreadsOpen, setIsThreadsOpen] = useState(false)
  const [mirroredHeaderWidth, setMirroredHeaderWidth] = useState<number | null>(
    null
  )
  const fallbackTransitionTimeoutRef = useRef<number | null>(null)
  const overflowPinnedTurnIdRef = useRef<string | null>(null)
  const threadsTriggerRef = useRef<HTMLDivElement | null>(null)
  const threadsPanelRef = useRef<HTMLDivElement | null>(null)
  const headerActionsRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()
  const threadStore = useThreadStore(initialThreads)
  const {
    state,
    queuedSubmission,
    streamingState,
    resetConversation,
    clearQueuedSubmission,
    handleStopStream,
    handlePromptSubmit,
    handleEditMessage,
  } = useAgentSession(threadStore)

  const hasMessages = state.messages.length > 0
  const fallbackTransitionMs = isMobile
    ? MOBILE_FALLBACK_TRANSITION_MS
    : DEFAULT_FALLBACK_TRANSITION_MS
  const homeHeroTransitionStyle: CSSProperties | undefined = isMobile
    ? undefined
    : {
        viewTransitionName: "chloei-home-hero",
      }
  const threadPaneTransitionStyle: CSSProperties | undefined = isMobile
    ? undefined
    : {
        viewTransitionName: "chloei-thread-pane",
      }
  const promptViewTransitionName = isMobile ? undefined : "chloei-prompt-shell"
  const showHomeView = !hasMessages || isFallbackEnteringConversation
  const isActiveTurnInProgress = state.isSubmitting || state.isStreaming
  const targetThreadScrollTop = useCallback(
    (
      targetScrollTop: number,
      {
        contentElement,
      }: {
        contentElement: HTMLElement
      }
    ) => {
      const latestTurnGroups = contentElement.querySelectorAll<HTMLElement>(
        "[data-message-group='turn']"
      )

      if (latestTurnGroups.length === 0) {
        return targetScrollTop
      }

      const latestTurnGroup = latestTurnGroups[latestTurnGroups.length - 1]

      if (!latestTurnGroup) {
        return targetScrollTop
      }

      const latestTurnId = latestTurnGroup.dataset.userMessageId ?? null
      const contentTop = contentElement.getBoundingClientRect().top
      const latestTurnTop = latestTurnGroup.getBoundingClientRect().top
      const anchoredTarget = Math.max(latestTurnTop - contentTop, 0)
      const scrollViewportHeight =
        contentElement.parentElement?.getBoundingClientRect().height ?? 0
      const latestVisibleTurnElement =
        latestTurnGroup.lastElementChild instanceof HTMLElement
          ? latestTurnGroup.lastElementChild
          : latestTurnGroup
      const latestVisibleTurnBoundary =
        latestVisibleTurnElement.getBoundingClientRect().bottom - latestTurnTop
      const promptElement =
        contentElement.querySelector<HTMLElement>("[data-prompt-form]")
      const promptHeight = promptElement?.getBoundingClientRect().height ?? 0
      // Use the last rendered item in the turn instead of the group's min-height
      // so the user's bubble keeps its original anchored position.
      const earlyTriggerOffset = Math.max(
        STREAMING_SCROLL_EARLY_TRIGGER_PX,
        promptHeight + STREAMING_SCROLL_PROMPT_BUFFER_PX
      )
      const latestTurnNearPrompt =
        scrollViewportHeight > 0 &&
        latestVisibleTurnBoundary > scrollViewportHeight - earlyTriggerOffset

      if (isActiveTurnInProgress && latestTurnNearPrompt && latestTurnId) {
        overflowPinnedTurnIdRef.current = latestTurnId
      }

      if (
        latestTurnNearPrompt &&
        latestTurnId !== null &&
        (isActiveTurnInProgress ||
          overflowPinnedTurnIdRef.current === latestTurnId)
      ) {
        return targetScrollTop
      }

      return anchoredTarget
    },
    [isActiveTurnInProgress]
  )

  const startFallbackConversationTransition = useCallback(() => {
    if (fallbackTransitionTimeoutRef.current !== null) {
      window.clearTimeout(fallbackTransitionTimeoutRef.current)
    }

    setIsFallbackEnteringConversation(true)
    fallbackTransitionTimeoutRef.current = window.setTimeout(() => {
      setIsFallbackEnteringConversation(false)
      fallbackTransitionTimeoutRef.current = null
    }, fallbackTransitionMs)
  }, [fallbackTransitionMs])

  const handleAnimatedPromptSubmit = useCallback(
    (
      message: string,
      model: ModelType,
      queue: boolean,
      runMode: AgentRunMode,
      attachments: AgentRequestAttachment[] = []
    ) => {
      if (queue) {
        handlePromptSubmit(message, model, queue, runMode, attachments)
        return
      }

      if (isMobile) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, queue, runMode, attachments)
        return
      }

      const startViewTransitionValue = Reflect.get(
        document,
        "startViewTransition"
      )
      const startViewTransition =
        typeof startViewTransitionValue === "function"
          ? (startViewTransitionValue as ViewTransitionStarter).bind(document)
          : null

      if (!startViewTransition) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, queue, runMode, attachments)
        return
      }

      startViewTransition(() => {
        flushSync(() => {
          handlePromptSubmit(message, model, queue, runMode, attachments)
        })
      })
    },
    [handlePromptSubmit, isMobile, startFallbackConversationTransition]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "i" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        resetConversation()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [resetConversation])

  useEffect(() => {
    return () => {
      if (fallbackTransitionTimeoutRef.current !== null) {
        window.clearTimeout(fallbackTransitionTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!hasMessages) {
      overflowPinnedTurnIdRef.current = null
    }
  }, [hasMessages])

  useEffect(() => {
    if (!isThreadsOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (
        threadsPanelRef.current?.contains(target) ||
        threadsTriggerRef.current?.contains(target)
      ) {
        return
      }

      setIsThreadsOpen(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [isThreadsOpen])

  useLayoutEffect(() => {
    const actionsElement = headerActionsRef.current

    if (!actionsElement || isMobile) {
      return
    }

    const syncMirroredHeaderWidth = () => {
      const nextWidth = Math.ceil(actionsElement.getBoundingClientRect().width)

      setMirroredHeaderWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth
      )
    }

    syncMirroredHeaderWidth()

    const resizeObserver = new ResizeObserver(() => {
      syncMirroredHeaderWidth()
    })

    resizeObserver.observe(actionsElement)
    window.addEventListener("resize", syncMirroredHeaderWidth)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener("resize", syncMirroredHeaderWidth)
    }
  }, [isMobile])

  const handleNewChat = useCallback(() => {
    setIsThreadsOpen(false)
    resetConversation()
  }, [resetConversation])

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="z-10 flex shrink-0 items-center justify-between bg-background p-3">
        <div
          className="flex min-w-0 items-center justify-start"
          style={
            !isMobile && mirroredHeaderWidth
              ? {
                  width: mirroredHeaderWidth,
                }
              : undefined
          }
        >
          <Button
            asChild
            variant="ghost"
            size="iconSm"
            aria-label="Go to Chloei home"
          >
            <Link href="/" onClick={handleNewChat}>
              <span className="relative block size-4 shrink-0 overflow-hidden">
                <span className="absolute inset-0 transition-opacity duration-100 group-hover/button:opacity-0 group-focus-visible/button:opacity-0">
                  <ChloeiLogoSvg className="size-full" />
                </span>
                <span className="absolute inset-0 opacity-0 transition-opacity duration-100 group-hover/button:opacity-100 group-focus-visible/button:opacity-100">
                  <span className="block h-4 w-[240px]">
                    <ChloeiLogoHoverSvg className="logo-sm size-full [animation-play-state:paused] group-hover/button:[animation-play-state:running] group-focus-visible/button:[animation-play-state:running]" />
                  </span>
                </span>
              </span>
            </Link>
          </Button>
        </div>

        <div ref={headerActionsRef} className="flex items-center gap-1">
          {hasMessages ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleNewChat}
                  aria-label="Start a new chat"
                >
                  <SquarePen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                New chat
              </TooltipContent>
            </Tooltip>
          ) : null}

          <div ref={threadsTriggerRef}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setIsThreadsOpen((open) => !open)
                  }}
                  aria-label="Open threads"
                  aria-expanded={isThreadsOpen}
                >
                  <History className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                Threads
              </TooltipContent>
            </Tooltip>
          </div>

          <AppLauncher className="size-7 text-muted-foreground hover:text-foreground" />
          <UserMenu
            viewer={viewer}
            className="size-7 text-muted-foreground hover:text-foreground"
          />
        </div>
      </div>

      <ThreadsPanel
        open={isThreadsOpen}
        onClose={() => {
          setIsThreadsOpen(false)
        }}
        panelRef={threadsPanelRef}
        threads={threadStore.threads}
        currentThreadId={threadStore.currentThreadId}
        setCurrentThreadId={threadStore.setCurrentThreadId}
      />

      {showHomeView ? (
        <div
          className={cn(
            "relative flex h-full w-full flex-col",
            isFallbackEnteringConversation &&
              (isMobile
                ? "pointer-events-none absolute inset-0 z-20 animate-[chloei-home-layer-out_110ms_var(--ease-out-cubic)_forwards] bg-background"
                : "pointer-events-none absolute inset-0 z-20 animate-[chloei-home-layer-out_140ms_var(--ease-in-out-cubic)_forwards] bg-background")
          )}
        >
          <div
            className={cn(
              "mx-auto flex w-full flex-1 flex-col items-center gap-10 px-4 pt-[20vh] sm:px-6",
              conversationWidthClass
            )}
          >
            <div
              style={homeHeroTransitionStyle}
              className="text-center font-departureMono text-2xl font-medium tracking-tighter select-none"
            >
              Welcome to <span className="text-muted-foreground">Chloei</span>
            </div>

            <PromptForm
              isHome
              onSubmit={handleAnimatedPromptSubmit}
              onStopStream={handleStopStream}
              isStreaming={streamingState}
              dismissKeyboardOnSubmit={isMobile}
              initialSelectedModel={initialSelectedModel}
              transition={{ isPending, startTransition }}
              viewTransitionName={promptViewTransitionName}
            />
          </div>
        </div>
      ) : null}

      {hasMessages ? (
        <StickToBottom
          className={cn(
            "relative flex min-h-0 w-full grow flex-col overflow-y-auto",
            isFallbackEnteringConversation &&
              (isMobile
                ? "animate-[chloei-thread-layer-in_110ms_var(--ease-out-cubic)_both]"
                : "animate-[chloei-thread-layer-in_150ms_var(--ease-out-cubic)_both]")
          )}
          resize="smooth"
          initial="smooth"
          targetScrollTop={targetThreadScrollTop}
        >
          <StickToBottom.Content className="relative flex min-h-full w-full flex-col">
            <div
              className={cn(
                "relative z-0 mx-auto flex w-full grow flex-col items-center px-4 sm:px-6",
                conversationWidthClass
              )}
            >
              <div
                style={threadPaneTransitionStyle}
                className="flex w-full grow flex-col"
              >
                <Messages
                  messages={state.messages}
                  disableEditing={state.isSubmitting || state.isStreaming}
                  onEditMessage={handleEditMessage}
                />
              </div>

              <ScrollToBottom />

              <PromptForm
                isHome
                onSubmit={handlePromptSubmit}
                onStopStream={handleStopStream}
                dockToBottomOnHome
                queuedMessage={queuedSubmission?.message ?? null}
                onClearQueuedMessage={clearQueuedSubmission}
                isStreaming={streamingState}
                dismissKeyboardOnSubmit={isMobile}
                initialSelectedModel={initialSelectedModel}
                transition={{ isPending, startTransition }}
                viewTransitionName={promptViewTransitionName}
              />
            </div>
          </StickToBottom.Content>
        </StickToBottom>
      ) : null}
    </div>
  )
}
