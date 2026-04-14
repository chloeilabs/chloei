import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
} from "lucide-react"
import { useMemo, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type ActivityTimelineEntry,
  isSearchToolName,
  type Message,
  type MessageSource,
  type SearchToolName,
  type ToolInvocationStatus,
} from "@/lib/shared"

import { Button } from "../../ui/button"
import { Source, SourceContent, SourceTrigger } from "../../ui/source"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { MemoizedMarkdown } from "../markdown/memoized-markdown"

function getAssistantContent(message: Message): string {
  const parts = message.metadata?.parts ?? []

  if (parts.length === 0) {
    return message.content
  }

  const text = parts.map((part) => part.text).join("")

  return text.length > 0 ? text : message.content
}

const activityLabelClassName =
  "inline-flex items-center bg-transparent p-0 font-departureMono text-[11px] font-medium tracking-wide text-muted-foreground/80"

function toReasoningEntries(reasoning: string): string[] {
  const normalized = reasoning.replace(/\r\n/g, "\n").trim()
  if (!normalized) {
    return []
  }

  return normalized
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isRedactedReasoningEntry(entry))
}

function isRedactedReasoningEntry(text: string): boolean {
  return text.trim() === "[REDACTED]"
}

function getSearchToolLabel(toolName: SearchToolName): string {
  if (toolName === "web_search") {
    return "Web"
  }

  if (toolName === "x_search") {
    return "X"
  }

  return "Tavily"
}

function getDedupedSources(
  sources: MessageSource[] | undefined
): MessageSource[] {
  const seenUrls = new Set<string>()
  const nextSources: MessageSource[] = []

  for (const source of sources ?? []) {
    if (!source.url || seenUrls.has(source.url)) {
      continue
    }

    seenUrls.add(source.url)
    nextSources.push(source)
  }

  return nextSources
}

function insertSourcesIntoTimeline(
  timeline: ActivityTimelineEntry[],
  sources: MessageSource[],
  createdAt: string
): ActivityTimelineEntry[] {
  if (
    sources.length === 0 ||
    timeline.some((entry) => entry.kind === "sources")
  ) {
    return timeline
  }

  const sourcesEntry: Extract<ActivityTimelineEntry, { kind: "sources" }> = {
    id: `${createdAt}-sources`,
    kind: "sources",
    order: -1,
    createdAt,
    sources,
  }

  const firstReasoningIndex = timeline.findIndex(
    (entry) => entry.kind === "reasoning"
  )
  const nextTimeline =
    firstReasoningIndex === -1
      ? [...timeline, sourcesEntry]
      : [
          ...timeline.slice(0, firstReasoningIndex),
          sourcesEntry,
          ...timeline.slice(firstReasoningIndex),
        ]

  return nextTimeline.map((entry, index) => ({ ...entry, order: index }))
}

function normalizeActivityTimeline(message: Message): ActivityTimelineEntry[] {
  const dedupedSources = getDedupedSources(message.metadata?.sources)
  const timeline = message.metadata?.activityTimeline
  if (Array.isArray(timeline) && timeline.length > 0) {
    const normalizedTimeline = [...timeline]
      .sort((a, b) => a.order - b.order)
      .flatMap((entry) => {
        if (
          entry.kind === "reasoning" &&
          isRedactedReasoningEntry(entry.text)
        ) {
          return []
        }

        if (entry.kind !== "tool" || !isSearchToolName(entry.toolName)) {
          return [entry]
        }

        const query = entry.label.trim()
        if (!query) {
          return [entry]
        }

        return [
          {
            id: entry.id,
            kind: "search" as const,
            order: entry.order,
            createdAt: entry.createdAt,
            callId: entry.callId,
            toolName: entry.toolName,
            query,
            status: entry.status,
          },
        ]
      })

    return insertSourcesIntoTimeline(
      normalizedTimeline,
      dedupedSources,
      message.createdAt
    )
  }

  const fallback: ActivityTimelineEntry[] = []
  const toolInvocations = message.metadata?.toolInvocations ?? []
  const reasoningEntries = toReasoningEntries(message.metadata?.reasoning ?? "")

  let order = 0
  for (const invocation of toolInvocations) {
    const normalizedInvocationQuery = invocation.query?.trim()
    const normalizedInvocationLabel = invocation.label.trim()
    const query = isSearchToolName(invocation.toolName)
      ? normalizedInvocationQuery && normalizedInvocationQuery.length > 0
        ? normalizedInvocationQuery
        : normalizedInvocationLabel.length > 0
          ? normalizedInvocationLabel
          : null
      : null

    if (isSearchToolName(invocation.toolName) && query) {
      fallback.push({
        id: invocation.id,
        kind: "search",
        order,
        createdAt: message.createdAt,
        callId: invocation.callId,
        toolName: invocation.toolName,
        query,
        status: invocation.status,
      })
      order += 1
      continue
    }

    fallback.push({
      id: invocation.id,
      kind: "tool",
      order,
      createdAt: message.createdAt,
      callId: invocation.callId,
      toolName: invocation.toolName,
      label: invocation.label,
      status: invocation.status,
    })
    order += 1
  }

  for (const entry of reasoningEntries) {
    fallback.push({
      id: `${message.id}-reasoning-${String(order)}`,
      kind: "reasoning",
      order,
      createdAt: message.createdAt,
      text: entry,
    })
    order += 1
  }

  return insertSourcesIntoTimeline(fallback, dedupedSources, message.createdAt)
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

function ToolStatusIcon({ status }: { status: ToolInvocationStatus }) {
  if (status === "running") {
    return (
      <LogoHover forceAnimate size="xs" className="shrink-0 text-foreground" />
    )
  }

  if (status === "success") {
    return <CircleCheck className="size-3.5 shrink-0 text-green-600" />
  }

  return <CircleX className="size-3.5 shrink-0 text-red-600" />
}

export function AssistantMessage({
  message,
}: {
  message: Message
}) {
  const content = useMemo(() => getAssistantContent(message), [message])
  const [activityVisibility, setActivityVisibility] = useState<
    "auto" | "expanded" | "collapsed"
  >("auto")

  const isAssistantStreaming = message.metadata?.isStreaming === true

  const activityTimeline = useMemo(
    () => normalizeActivityTimeline(message),
    [message]
  )
  const sources = useMemo(
    () => getDedupedSources(message.metadata?.sources),
    [message.metadata?.sources]
  )
  const showSourceFavicon = true
  const { copyToClipboard, isCopied } = useCopyToClipboard()

  const hasContent = content.trim().length > 0
  const hasSources = sources.length > 0
  const hasActivity = activityTimeline.length > 0 || hasSources
  const showActivitySection = hasActivity
  const shouldShimmerActivityLabel = isAssistantStreaming && !hasContent
  const isActivityCollapsed =
    activityVisibility === "collapsed" ||
    (activityVisibility === "auto" && !isAssistantStreaming)

  if (!hasContent && !hasActivity) {
    return null
  }

  return (
    <div
      data-message-role="assistant"
      className="group/assistant-message relative flex flex-col gap-1"
    >
      {showActivitySection && (
        <div className="px-3 pt-2">
          <div className="mb-1">
            <button
              type="button"
              className={`${activityLabelClassName} cursor-pointer gap-1 transition-colors hover:text-foreground`}
              aria-expanded={!isActivityCollapsed}
              onClick={() => {
                setActivityVisibility((current) => {
                  if (current === "auto") {
                    return isAssistantStreaming ? "collapsed" : "expanded"
                  }

                  return current === "collapsed" ? "expanded" : "collapsed"
                })
              }}
            >
              <span
                className={shouldShimmerActivityLabel ? "shimmer" : undefined}
              >
                Activity
              </span>
              <ChevronDown
                className={`size-3.5 transition-transform ${
                  isActivityCollapsed ? "-rotate-90" : "rotate-0"
                }`}
              />
            </button>
          </div>
          {!isActivityCollapsed && (
            <div className="flex flex-col gap-2">
              {activityTimeline.map((entry) => {
                if (entry.kind === "search") {
                  const showSearchToolLabel = entry.toolName === "x_search"
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
                    >
                      <ToolStatusIcon status={entry.status} />
                      {showSearchToolLabel && (
                        <>
                          <span className="font-medium text-foreground">
                            {getSearchToolLabel(entry.toolName)}
                          </span>
                          <span className="text-muted-foreground/60">·</span>
                        </>
                      )}
                      <span className="truncate">{entry.query}</span>
                    </div>
                  )
                }

                if (entry.kind === "sources") {
                  return (
                    <div
                      key={entry.id}
                      className="rounded-none border bg-muted/40 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap gap-1.5">
                        {entry.sources.map((source) => (
                          <Source href={source.url} key={source.id}>
                            <SourceTrigger
                              label={source.title}
                              showFavicon={showSourceFavicon}
                              className="max-w-full"
                            />
                            <SourceContent
                              title={source.title}
                              description={source.url}
                              showFavicon={showSourceFavicon}
                            />
                          </Source>
                        ))}
                      </div>
                    </div>
                  )
                }

                if (entry.kind === "tool") {
                  return (
                    <div
                      key={entry.id}
                      className="rounded-none border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
                    >
                      <div className="flex items-center gap-1.5">
                        <ToolStatusIcon status={entry.status} />
                        <span className="truncate">{entry.label}</span>
                      </div>
                    </div>
                  )
                }

                return (
                  <div
                    key={entry.id}
                    className="rounded-none border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground [&_.prose]:w-full [&_.prose]:text-xs [&_.prose]:leading-relaxed [&_.prose>*]:my-0 [&_.prose>*+*]:mt-3 [&_.yurie-markdown]:w-full"
                  >
                    <div className="min-w-0">
                      <MemoizedMarkdown
                        className="space-y-0 [&>.yurie-markdown:has(p)]:mb-2.5 [&>.yurie-markdown:has(p):last-child]:mb-0"
                        content={entry.text}
                        id={`${entry.id}-activity`}
                        showSourceFavicon={showSourceFavicon}
                        sources={sources}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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
        </div>
      )}

      <div
        className="opacity-0 transition-opacity group-hover/assistant-message:opacity-100"
        hidden={!hasContent}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="iconXs"
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
      </div>
    </div>
  )
}
