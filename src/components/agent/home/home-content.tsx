"use client"

import { LightbulbIcon, SearchIcon, TelescopeIcon } from "lucide-react"
import dynamic from "next/dynamic"
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { flushSync } from "react-dom"
import { Toaster } from "sonner"
import { StickToBottom } from "use-stick-to-bottom"

import { AppSidebar } from "@/components/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  type AuthViewer,
  type MessageAttachment,
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { PromptForm } from "../prompt-form/prompt-form"
import { ModelSelector } from "./model-selector"
import { ScrollToBottom } from "./scroll-to-bottom"
import { useThreadStoreContext } from "./thread-store-context"
import { useAgentSession } from "./use-agent-session"

const TRIGGER_CLASS = "size-8 text-white/70 hover:bg-white/10 hover:text-white"

const HOME_SUGGESTIONS = [
  { icon: SearchIcon, label: "Look something up", prompt: "Look up " },
  { icon: TelescopeIcon, label: "Research something", prompt: "Research " },
  { icon: LightbulbIcon, label: "Explain something", prompt: "Explain " },
] as const

type ViewTransitionStarter = (updateCallback: () => void) => unknown

const DEFAULT_FALLBACK_TRANSITION_MS = 150
const MOBILE_FALLBACK_TRANSITION_MS = 110
const STREAMING_SCROLL_EARLY_TRIGGER_PX = 72
const STREAMING_SCROLL_PROMPT_BUFFER_PX = 24
// Leave a little breathing room above the user's bubble whenever a turn is
// anchored to the top — both while streaming and when revisiting a thread —
// instead of pinning it flush against the top edge and the floating controls.
const ANCHOR_TOP_GAP_PX = 44
const homeWidthClass = "max-w-[768px]"
const conversationWidthClass = "max-w-[816px]"

const Messages = dynamic(
  () => import("../messages/messages").then((mod) => mod.Messages),
  {
    loading: () => <div className="mb-10 flex w-full grow" />,
  }
)

/**
 * The main-header sidebar toggle. On desktop the sidebar collapses to an icon
 * rail whose header always shows the toggle, so the main-header copy is only
 * needed on mobile (where the sidebar is an off-canvas sheet).
 */
function MainSidebarTrigger() {
  const { isMobile } = useSidebar()

  if (!isMobile) {
    return null
  }

  return <SidebarTrigger className={`pointer-events-auto ${TRIGGER_CLASS}`} />
}

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
  const fallbackTransitionTimeoutRef = useRef<number | null>(null)
  const overflowPinnedTurnIdRef = useRef<string | null>(null)
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
      _queue: boolean,
      attachments: MessageAttachment[]
    ) => {
      handlePromptSubmit(message, model, attachments)
    },
    [handlePromptSubmit]
  )

  const handleFollowUpQuestionClick = useCallback(
    ({ model, question }: { model: ModelType; question: string }) => {
      handlePromptSubmit(question, model)
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
      const contentTop = contentElement.getBoundingClientRect().top
      const latestTurnTop = latestTurnGroup.getBoundingClientRect().top
      const anchoredTarget = Math.max(
        latestTurnTop - contentTop - ANCHOR_TOP_GAP_PX,
        0
      )
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
      _queue: boolean,
      attachments: MessageAttachment[]
    ) => {
      if (isMobile) {
        startFallbackConversationTransition()
        handlePromptSubmit(message, model, attachments)
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
        handlePromptSubmit(message, model, attachments)
        return
      }

      startViewTransition(() => {
        flushSync(() => {
          handlePromptSubmit(message, model, attachments)
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

  const handleNewChat = useCallback(() => {
    resetConversation()
  }, [resetConversation])

  const [seedMessage, setSeedMessage] = useState<{
    id: number
    text: string
  } | null>(null)

  const applySuggestion = useCallback((prompt: string) => {
    setSeedMessage((previous) => ({
      id: (previous?.id ?? 0) + 1,
      text: prompt,
    }))
  }, [])

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
        {/* Match sidebar header rhythm: px-2.5 pt-3 + h-8 controls. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center px-2.5 pt-3">
          <div className="flex h-8 min-w-0 items-center gap-1">
            <MainSidebarTrigger />
            <ModelSelector initialSelectedModel={initialSelectedModel} />
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
            <div className="flex min-h-full items-center justify-center p-6 max-sm:px-3">
              <div
                style={homeHeroTransitionStyle}
                className={cn(
                  "flex w-full min-w-0 -translate-y-[72px] flex-col gap-8",
                  homeWidthClass
                )}
              >
                <h1 className="text-center text-[19px] font-normal text-white select-none sm:text-[23px]">
                  What’s on your mind today?
                </h1>
                <div className="flex flex-col gap-7">
                  <PromptForm
                    key={seedMessage?.id ?? "home-prompt"}
                    isHome
                    initialMessage={seedMessage?.text}
                    onSubmit={handleAnimatedPromptSubmit}
                    onStopStream={handleStopStream}
                    isStreaming={streamingState}
                    dismissKeyboardOnSubmit={isMobile}
                    initialSelectedModel={initialSelectedModel}
                    transition={{ isPending, startTransition }}
                    viewTransitionName={promptViewTransitionName}
                  />
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {HOME_SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => {
                          applySuggestion(prompt)
                        }}
                        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-background px-4 py-2.5 text-sm text-[#afafaf] transition-colors hover:bg-[#414141] hover:text-white"
                      >
                        <Icon className="size-4" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {showConversationView ? (
          <StickToBottom
            className={cn(
              "relative flex min-h-0 w-full grow [scrollbar-gutter:stable_both-edges] flex-col overflow-y-auto",
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
                  "relative z-0 mx-auto flex w-full grow flex-col items-center px-6 pt-14 max-sm:px-3 lg:pt-10",
                  conversationWidthClass
                )}
              >
                <div
                  style={threadPaneTransitionStyle}
                  className="flex w-full grow flex-col gap-6"
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
