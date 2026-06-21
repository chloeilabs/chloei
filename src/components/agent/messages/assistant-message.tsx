import { Check, Copy, CornerDownRight, RefreshCcw } from "lucide-react"
import dynamic from "next/dynamic"
import { useMemo } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type FollowUpQuestion,
  isModelType,
  type Message,
  type ModelType,
} from "@/lib/shared"

import { Button } from "../../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { ActivityTimeline } from "./activity-timeline"
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
  const isAssistantStreaming = message.metadata?.isStreaming === true

  const activityTimeline = useMemo(
    () => normalizeAssistantActivityTimeline(message),
    [message]
  )
  const sources = useMemo(
    () => getDedupedSources(message.metadata?.sources),
    [message.metadata?.sources]
  )
  const showSourceFavicon = true
  const { copyToClipboard, isCopied } = useCopyToClipboard()

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

  if (!hasContent && !hasActivity) {
    return null
  }

  return (
    <div
      data-message-role="assistant"
      data-streaming={isAssistantStreaming ? "true" : "false"}
      className="relative flex flex-col gap-1"
    >
      <ActivityTimeline
        entries={activityTimeline}
        message={message}
        isStreaming={isAssistantStreaming}
        hasContent={hasContent}
      />

      {hasContent && (
        <div className="px-3 py-2 text-base">
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
