import {
  Check,
  CircleX,
  Copy,
  CornerDownRight,
  RefreshCcw,
  Wrench,
} from "lucide-react"
import dynamic from "next/dynamic"
import { useEffect, useMemo, useRef, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { Skeleton } from "@/components/ui/skeleton"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type FollowUpQuestion,
  isModelType,
  type Message,
  type ModelType,
} from "@/lib/shared"
import { cn } from "@/lib/utils"

import { Button } from "../../ui/button"
import { Source, SourceContent, SourceTrigger } from "../../ui/source"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import {
  getDedupedSources,
  normalizeAssistantActivityTimeline,
} from "./assistant-activity-timeline"

const MemoizedMarkdown = dynamic(
  () =>
    import("../markdown/memoized-markdown").then(
      (module) => module.MemoizedMarkdown
    ),
  {
    loading: () => <Skeleton className="h-5 w-32" />,
    ssr: false,
  }
)

// Hide canned suggestions persisted by earlier builds; new follow-ups must come
// from /api/agent/follow-ups.
const LEGACY_CANNED_FOLLOW_UP_ID_PREFIX = "fallback-follow-up"

function getAssistantContent(message: Message): string {
  const parts = message.metadata?.parts ?? []

  if (parts.length === 0) {
    return message.content
  }

  const text = parts.map((part) => part.text).join("")

  return text.length > 0 ? text : message.content
}

function formatActivityDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))

  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return seconds > 0
    ? `${String(minutes)}m ${String(seconds)}s`
    : `${String(minutes)}m`
}

export function CraftingShimmer() {
  return (
    <div className="px-3 pt-2">
      <div className="flex w-fit items-center">
        <span
          aria-hidden="true"
          className="crafting-dot-pulse mt-px size-2 shrink-0 rounded-full bg-foreground"
        />
      </div>
    </div>
  )
}

type ActivityEntry = ReturnType<
  typeof normalizeAssistantActivityTimeline
>[number]

function activityStepLabel(entry: ActivityEntry): string {
  switch (entry.kind) {
    case "reasoning":
      return "Thinking"
    case "search":
      return entry.status === "running"
        ? "Searching the web"
        : "Searched the web"
    case "sources":
      return "Sources"
    default:
      return entry.label
  }
}

// Exact replicas of onyx's @opal/icons used in its agent timeline.
function TimelineCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="4" strokeWidth={1.5} />
    </svg>
  )
}

function TimelineGlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M14.6667 8C14.6667 11.6819 11.6819 14.6667 8 14.6667M14.6667 8C14.6667 4.3181 11.6819 1.33333 8 1.33333M14.6667 8H1.33334M8 14.6667C4.31811 14.6667 1.33334 11.6819 1.33334 8M8 14.6667C9.66753 12.8411 10.6152 10.472 10.6667 8C10.6152 5.52802 9.66753 3.1589 8 1.33333M8 14.6667C6.33249 12.8411 5.38484 10.472 5.33334 8C5.38484 5.52802 6.33249 3.1589 8 1.33333M1.33334 8C1.33334 4.3181 4.31811 1.33333 8 1.33333"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TimelineFoldIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M11 3.25L8.47136 5.77857C8.21103 6.0389 7.78889 6.0389 7.52856 5.77857L4.99999 3.25M11 12.75L8.47136 10.2214C8.21103 9.96103 7.78889 9.96103 7.52856 10.2214L4.99999 12.75"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TimelineExpandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M4.99994 5.49995L7.52858 2.97131C7.78891 2.71098 8.21105 2.71098 8.47138 2.97131L11 5.49995M5.00024 10.5L7.5288 13.0286C7.78914 13.2889 8.21127 13.2889 8.4716 13.0286L11.0002 10.5"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ActivityStepIcon({ entry }: { entry: ActivityEntry }) {
  if (
    (entry.kind === "tool" || entry.kind === "search") &&
    entry.status === "running"
  ) {
    return <LogoHover forceAnimate size="xs" className="text-foreground" />
  }

  if (
    (entry.kind === "tool" || entry.kind === "search") &&
    entry.status === "error"
  ) {
    return <CircleX className="size-3 text-destructive" />
  }

  if (entry.kind === "search") {
    return <TimelineGlobeIcon className="size-3 text-muted-foreground" />
  }

  // Onyx renders the fetch step (which surfaces sources) with the same circle.
  if (entry.kind === "sources" || entry.kind === "reasoning") {
    return <TimelineCircleIcon className="size-3 text-muted-foreground" />
  }

  return <Wrench className="size-3 text-muted-foreground" />
}

const INITIAL_SOURCES_SHOWN = 3

function SourceList({
  sources,
  showFavicon,
}: {
  sources: ReturnType<typeof getDedupedSources>
  showFavicon: boolean
}) {
  const [showAll, setShowAll] = useState(false)

  if (sources.length === 0) {
    return null
  }

  const visibleSources = showAll
    ? sources
    : sources.slice(0, INITIAL_SOURCES_SHOWN)
  const remaining = sources.length - visibleSources.length

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleSources.map((source, index) => (
        <div
          key={`${source.id}:${source.url}`}
          className="flex max-w-full min-w-0 animate-in duration-150 fade-in slide-in-from-left-2"
          style={{
            animationDelay: `${String(Math.min(index, 8) * 30)}ms`,
            animationFillMode: "backwards",
          }}
        >
          <Source href={source.url}>
            <SourceTrigger
              label={source.title}
              showFavicon={showFavicon}
              className="max-w-52"
            />
            <SourceContent
              title={source.title}
              description={source.url}
              showFavicon={showFavicon}
            />
          </Source>
        </div>
      ))}
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => {
            setShowAll(true)
          }}
          className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          +{remaining} more
        </button>
      ) : null}
    </div>
  )
}

function FollowUpQuestions({
  onSelect,
  questions,
}: {
  onSelect: (question: string) => void
  questions: FollowUpQuestion[]
}) {
  if (questions.length === 0) {
    return null
  }

  return (
    <div
      aria-label="Follow-up questions"
      className="mt-3 flex flex-col items-start gap-1"
    >
      {questions.map((question) => (
        <Button
          className="-mx-2 h-auto max-w-full justify-start gap-1.5 border-transparent bg-transparent px-2 py-1 text-left text-sm leading-snug font-normal whitespace-normal text-muted-foreground shadow-none hover:bg-muted/35 hover:text-foreground focus-visible:border-transparent focus-visible:bg-muted/35 focus-visible:ring-0 dark:hover:bg-muted/20"
          key={question.id}
          onClick={() => {
            onSelect(question.text)
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          <CornerDownRight className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0">{question.text}</span>
        </Button>
      ))}
    </div>
  )
}

function FollowUpQuestionsPending() {
  return (
    <div
      aria-busy="true"
      aria-label="Follow-up questions"
      className="mt-3 flex flex-col items-start gap-1"
    >
      <div className="-mx-2 flex h-7 max-w-full items-center gap-1.5 px-2 py-1">
        <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/30" />
        <Skeleton className="h-3 w-72 max-w-[70vw]" />
      </div>
      <div className="-mx-2 flex h-7 max-w-full items-center gap-1.5 px-2 py-1">
        <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/30" />
        <Skeleton className="h-3 w-64 max-w-[64vw]" />
      </div>
      <div className="-mx-2 flex h-7 max-w-full items-center gap-1.5 px-2 py-1">
        <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/30" />
        <Skeleton className="h-3 w-80 max-w-[74vw]" />
      </div>
    </div>
  )
}

export function AssistantMessage({
  message,
  onFollowUpQuestionClick,
  onRegenerate,
}: {
  message: Message
  onFollowUpQuestionClick?: (params: {
    model: ModelType
    question: string
  }) => void
  onRegenerate?: () => void
}) {
  const content = useMemo(() => getAssistantContent(message), [message])
  // Onyx default: the timeline is collapsed and only expands when the user
  // clicks the header (collapsed during streaming and after completion).
  const [isActivityExpanded, setIsActivityExpanded] = useState(false)

  const isAssistantStreaming = message.metadata?.isStreaming === true

  const [activityDurationMs, setActivityDurationMs] = useState<number | null>(
    null
  )
  const activityStartRef = useRef<number | null>(null)
  useEffect(() => {
    if (!isAssistantStreaming) {
      return
    }

    activityStartRef.current ??= Date.now()
    const intervalId = setInterval(() => {
      const startedAt = activityStartRef.current
      if (startedAt != null) {
        setActivityDurationMs(Date.now() - startedAt)
      }
    }, 500)

    return () => {
      clearInterval(intervalId)
    }
  }, [isAssistantStreaming])

  const activityTimeline = useMemo(
    () => normalizeAssistantActivityTimeline(message),
    [message]
  )
  const sources = useMemo(
    () => getDedupedSources(message.metadata?.sources),
    [message.metadata?.sources]
  )
  const hasRunningActivity = useMemo(
    () =>
      activityTimeline.some(
        (entry) =>
          (entry.kind === "tool" || entry.kind === "search") &&
          entry.status === "running"
      ),
    [activityTimeline]
  )
  const showSourceFavicon = true
  const { copyToClipboard, isCopied } = useCopyToClipboard()
  const hasActiveActivity =
    isAssistantStreaming ||
    hasRunningActivity ||
    message.metadata?.agentStatus === "in_progress"
  const followUpModel = isModelType(message.llmModel)
    ? message.llmModel
    : message.metadata?.selectedModel
  const followUpQuestions = isAssistantStreaming
    ? []
    : (message.metadata?.followUpQuestions ?? []).filter(
        (question) => !question.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
      )
  const isFollowUpQuestionsPending =
    !isAssistantStreaming &&
    message.metadata?.followUpQuestionsPending === true &&
    followUpQuestions.length === 0

  const hasContent = content.trim().length > 0
  const hasActivity = activityTimeline.length > 0
  const showActivitySection = hasActivity
  const isActivityShimmering =
    hasRunningActivity || (isAssistantStreaming && !hasContent)
  const isActivityCollapsed = !isActivityExpanded

  const lastActivityEntry = activityTimeline.at(-1)
  const lastEntryHasPreview =
    lastActivityEntry != null &&
    ((lastActivityEntry.kind === "reasoning" &&
      lastActivityEntry.text.length > 0) ||
      lastActivityEntry.kind === "search" ||
      lastActivityEntry.kind === "sources")
  // Onyx keeps the timeline collapsed while streaming and surfaces only a
  // compact preview of the current step under the shimmer header.
  const showActivityPreview =
    hasActiveActivity && !isActivityExpanded && lastEntryHasPreview

  const stepCount = activityTimeline.length
  const runningEntry = activityTimeline
    .filter(
      (entry) =>
        (entry.kind === "tool" || entry.kind === "search") &&
        entry.status === "running"
    )
    .at(-1)
  let currentActivityLabel = isAssistantStreaming ? "Thinking" : "Working"
  if (runningEntry?.kind === "search") {
    currentActivityLabel = "Searching the web"
  } else if (runningEntry?.kind === "tool") {
    currentActivityLabel = runningEntry.label
  }

  let activityHeaderLabel = "Thought for some time"
  if (hasActiveActivity) {
    activityHeaderLabel = currentActivityLabel
  } else if (activityDurationMs != null) {
    activityHeaderLabel = `Thought for ${formatActivityDuration(activityDurationMs)}`
  }

  let activityHeaderMeta = `${String(stepCount)} ${
    stepCount === 1 ? "step" : "steps"
  }`
  if (hasActiveActivity && activityDurationMs != null) {
    activityHeaderMeta = formatActivityDuration(activityDurationMs)
  }

  if (!hasContent && !hasActivity) {
    return null
  }

  return (
    <div
      data-message-role="assistant"
      data-streaming={isAssistantStreaming ? "true" : "false"}
      className="relative flex flex-col gap-1"
    >
      {showActivitySection && (
        <div className="px-3 pt-2">
          <div
            className={cn(
              "overflow-hidden rounded-xl transition-colors duration-200",
              isActivityExpanded ? "bg-muted/30" : "bg-transparent"
            )}
          >
            <button
              type="button"
              aria-expanded={!isActivityCollapsed}
              onClick={() => {
                setIsActivityExpanded((prev) => !prev)
              }}
              className="flex h-9 w-full items-center justify-between gap-2 px-3"
            >
              <span
                className={cn(
                  "truncate text-[13px] text-muted-foreground",
                  isActivityShimmering && "shimmer"
                )}
              >
                {activityHeaderLabel}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60">
                <span className="tabular-nums">{activityHeaderMeta}</span>
                {isActivityCollapsed ? (
                  <TimelineExpandIcon className="size-3.5" />
                ) : (
                  <TimelineFoldIcon className="size-3.5" />
                )}
              </span>
            </button>

            {showActivityPreview && (
              <div className="px-3 pb-2">
                {lastActivityEntry.kind === "reasoning" && (
                  <div className="line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/60">
                    {lastActivityEntry.text}
                  </div>
                )}
                {lastActivityEntry.kind === "search" && (
                  <span className="inline-block max-w-full truncate rounded-lg bg-muted/60 px-2 py-1 align-middle text-xs text-muted-foreground">
                    {lastActivityEntry.query}
                  </span>
                )}
                {lastActivityEntry.kind === "sources" && (
                  <SourceList
                    sources={lastActivityEntry.sources}
                    showFavicon={showSourceFavicon}
                  />
                )}
              </div>
            )}

            {!isActivityCollapsed && (
              <div className="flex animate-in flex-col pb-1 duration-300 fade-in slide-in-from-top-2">
                {activityTimeline.map((entry, index) => {
                  const isFirst = index === 0
                  const isLast = index === activityTimeline.length - 1

                  return (
                    <div key={entry.id} className="flex gap-2.5 px-3">
                      <div className="relative flex w-5 shrink-0 flex-col items-center">
                        <div className="flex h-8 w-full flex-col items-center">
                          <div
                            className={cn("h-2 w-px", !isFirst && "bg-border")}
                          />
                          <div className="flex size-5 shrink-0 items-center justify-center">
                            <ActivityStepIcon entry={entry} />
                          </div>
                          <div
                            className={cn(
                              "w-px flex-1",
                              !isLast && "bg-border"
                            )}
                          />
                        </div>
                        {!isLast && <div className="w-px flex-1 bg-border" />}
                      </div>

                      <div className="min-w-0 flex-1 pb-1">
                        <div className="flex h-8 items-center">
                          <span className="truncate text-xs text-muted-foreground/80">
                            {activityStepLabel(entry)}
                          </span>
                        </div>
                        {entry.kind === "reasoning" &&
                          entry.text.length > 0 && (
                            <div className="pb-1 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/60">
                              {entry.text}
                            </div>
                          )}
                        {entry.kind === "search" && (
                          <div className="pb-1">
                            <span className="inline-block max-w-full truncate rounded-lg bg-muted/60 px-2 py-1 align-middle text-xs text-muted-foreground">
                              {entry.query}
                            </span>
                          </div>
                        )}
                        {entry.kind === "sources" && (
                          <div className="pb-1">
                            <SourceList
                              sources={entry.sources}
                              showFavicon={showSourceFavicon}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {hasContent && (
        <div className="px-3 py-2 text-sm">
          <MemoizedMarkdown
            content={content}
            id={`${message.id}-text`}
            showSourceFavicon={showSourceFavicon}
            sources={sources}
          />
          {!isAssistantStreaming ? (
            <div className="mt-2 flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={isCopied ? "Response copied" : "Copy response"}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void copyToClipboard(content)
                    }}
                  >
                    {isCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Copy response</TooltipContent>
              </Tooltip>
              {onRegenerate ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Regenerate response"
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={onRegenerate}
                    >
                      <RefreshCcw className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Regenerate response
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
          {followUpModel && onFollowUpQuestionClick ? (
            isFollowUpQuestionsPending ? (
              <FollowUpQuestionsPending />
            ) : (
              <FollowUpQuestions
                questions={followUpQuestions}
                onSelect={(question) => {
                  onFollowUpQuestionClick({
                    model: followUpModel,
                    question,
                  })
                }}
              />
            )
          ) : null}
        </div>
      )}
    </div>
  )
}
