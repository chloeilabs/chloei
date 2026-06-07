"use client"

import { SquarePen } from "lucide-react"
import dynamic from "next/dynamic"
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { flushSync } from "react-dom"
import { Toaster } from "sonner"
import { StickToBottom } from "use-stick-to-bottom"

import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
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
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { ScrollToBottom } from "../../task/scroll-to-bottom"
import { TradingDeskNavButton } from "../../trading-desk-nav-button"
import { PromptForm } from "../prompt-form/prompt-form"
import { useThreadStoreContext } from "./thread-store-context"
import { useAgentSession } from "./use-agent-session"

type ViewTransitionStarter = (updateCallback: () => void) => unknown

const DEFAULT_FALLBACK_TRANSITION_MS = 150
const MOBILE_FALLBACK_TRANSITION_MS = 110
const STREAMING_SCROLL_EARLY_TRIGGER_PX = 72
const STREAMING_SCROLL_PROMPT_BUFFER_PX = 24
const conversationWidthClass = "max-w-[50rem]"

const Messages = dynamic(
  () => import("../messages/messages").then((mod) => mod.Messages),
  {
    loading: () => <div className="mb-10 flex w-full grow" />,
  }
)

export function HomePageContent({
  initialSelectedModel,
  viewer,
}: {
  initialSelectedModel?: ModelType | null
  viewer: AuthViewer
}) {
  const [isPending, startTransition] = useTransition()
  const [isFallbackEnteringConversation, setIsFallbackEnteringConversation] =
    useState(false)
  const [mirroredHeaderWidth, setMirroredHeaderWidth] = useState<number | null>(
    null
  )
  const fallbackTransitionTimeoutRef = useRef<number | null>(null)
  const overflowPinnedTurnIdRef = useRef<string | null>(null)
  const headerActionsRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()
  const threadStore = useThreadStoreContext()
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

  const handlePromptFormSubmit = useCallback(
    (
      message: string,
      model: ModelType,
      _isStreaming: boolean,
      runMode: AgentRunMode,
      attachments: AgentRequestAttachment[] = []
    ) => {
      handlePromptSubmit(message, model, runMode, attachments)
    },
    [handlePromptSubmit]
  )

  const handleFollowUpQuestionClick = useCallback(
    ({
      model,
      question,
      runMode,
    }: {
      model: ModelType
      question: string
      runMode: AgentRunMode
    }) => {
      handlePromptSubmit(question, model, runMode)
    },
    [handlePromptSubmit]
  )

  const hasMessages = state.messages.length > 0
  const hasActiveThread = threadStore.currentThreadId !== null
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
  const showHomeView =
    (!hasMessages && !hasActiveThread) || isFallbackEnteringConversation
  const showConversationView = hasMessages || hasActiveThread
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
      const isOnlyTurn = latestTurnGroups.length === 1
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

      if (
        isOnlyTurn &&
        latestTurnId !== null &&
        (isActiveTurnInProgress ||
          overflowPinnedTurnIdRef.current === latestTurnId)
      ) {
        overflowPinnedTurnIdRef.current = latestTurnId
        return targetScrollTop
      }

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
      _isStreaming: boolean,
      runMode: AgentRunMode,
      attachments: AgentRequestAttachment[] = []
    ) => {
      if (isMobile) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, runMode, attachments)
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
        handlePromptSubmit(message, model, runMode, attachments)
        return
      }

      startViewTransition(() => {
        flushSync(() => {
          handlePromptSubmit(message, model, runMode, attachments)
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
    resetConversation()
  }, [resetConversation])

  return (
    <SidebarProvider className="min-h-0 flex-1">
      <AppSidebar
        viewer={viewer}
        threadSummaries={threadStore.threadSummaries}
        isThreadSummariesLoading={threadStore.isLoadingThreadSummaries}
        currentThreadId={threadStore.currentThreadId}
        onSelectThread={threadStore.setCurrentThreadId}
        onDeleteThread={threadStore.deleteThread}
        onNewChat={handleNewChat}
      />
      <SidebarInset className="relative flex min-h-0 w-full flex-col overflow-hidden">
        <div className="z-10 flex shrink-0 items-center justify-between bg-background p-3">
          <div
            className="flex min-w-0 items-center justify-start gap-1"
            style={
              !isMobile && mirroredHeaderWidth
                ? {
                    width: mirroredHeaderWidth,
                  }
                : undefined
            }
          >
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          </div>

          <div ref={headerActionsRef} className="flex items-center gap-1">
            {hasActiveThread ? (
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

            <TradingDeskNavButton />
          </div>
        </div>

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

        {showConversationView ? (
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
                    onFollowUpQuestionClick={handleFollowUpQuestionClick}
                  />
                </div>

                <ScrollToBottom />

                <PromptForm
                  isHome
                  onSubmit={handlePromptFormSubmit}
                  onStopStream={handleStopStream}
                  dockToBottomOnHome
                  queuedSubmission={queuedSubmission}
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
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  )
}
