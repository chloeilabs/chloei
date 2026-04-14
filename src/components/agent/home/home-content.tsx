"use client"
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { flushSync } from "react-dom"
import { StickToBottom } from "use-stick-to-bottom"

import { AppLauncher } from "@/components/agent/home/app-launcher"
import { AppSidebar } from "@/components/agent/home/app-sidebar"
import { UserMenu } from "@/components/auth/user-menu"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import type { AuthViewer, ModelType } from "@/lib/shared"
import { cn } from "@/lib/utils"

import { LogoHover } from "../../graphics/logo/logo-hover"
import { ScrollToBottom } from "../../task/scroll-to-bottom"
import { Messages } from "../messages/messages"
import { PromptForm } from "../prompt-form/prompt-form"
import { useAgentSession } from "./use-agent-session"

type ViewTransitionStarter = (updateCallback: () => void) => unknown
const DEFAULT_FALLBACK_TRANSITION_MS = 150
const MOBILE_FALLBACK_TRANSITION_MS = 110
const STREAMING_SCROLL_EARLY_TRIGGER_PX = 72
const STREAMING_SCROLL_PROMPT_BUFFER_PX = 24

export function HomePageContent({
  initialSelectedModel,
  initialSidebarOpen = true,
  viewer,
}: {
  initialSelectedModel?: ModelType | null
  initialSidebarOpen?: boolean
  viewer: AuthViewer
}) {
  const [isPending, startTransition] = useTransition()
  const [isFallbackEnteringConversation, setIsFallbackEnteringConversation] =
    useState(false)
  const fallbackTransitionTimeoutRef = useRef<number | null>(null)
  const overflowPinnedTurnIdRef = useRef<string | null>(null)
  const isMobile = useIsMobile()
  const {
    state,
    queuedSubmission,
    streamingState,
    resetConversation,
    clearQueuedSubmission,
    handleStopStream,
    handlePromptSubmit,
    handleEditMessage,
  } = useAgentSession()

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

      const latestTurnGroup = latestTurnGroups[latestTurnGroups.length - 1] as
        | HTMLElement
        | undefined

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
    (message: string, model: ModelType, queue: boolean) => {
      if (queue) {
        handlePromptSubmit(message, model, queue)
        return
      }

      if (isMobile) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, queue)
        return
      }

      const startViewTransition = (
        document as unknown as {
          startViewTransition?: ViewTransitionStarter
        }
      ).startViewTransition?.bind(document)

      if (!startViewTransition) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, queue)
        return
      }

      startViewTransition(() => {
        flushSync(() => {
          handlePromptSubmit(message, model, queue)
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

  return (
    <SidebarProvider defaultOpen={initialSidebarOpen}>
      <AppSidebar onGoHome={resetConversation} />

      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="relative flex h-full w-full flex-col">
          <div className="z-10 flex shrink-0 items-center justify-between bg-background p-3">
            <SidebarTrigger />
            <div className="flex items-center gap-1.5">
              <AppLauncher className="size-7" />
              <UserMenu viewer={viewer} className="size-7" />
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
              <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-10 px-4 pt-[20vh] sm:px-6">
                <div
                  style={homeHeroTransitionStyle}
                  className="flex items-center gap-4 font-departureMono text-2xl font-medium tracking-tighter select-none"
                >
                  <LogoHover size="lg" />
                  Welcome to{" "}
                  <span className="text-muted-foreground">Chloei</span>
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
                <div className="relative z-0 mx-auto flex w-full max-w-3xl grow flex-col items-center px-4 sm:px-6">
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
      </SidebarInset>
    </SidebarProvider>
  )
}
