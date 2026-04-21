import { Check, ChevronDown, CircleCheck, CircleX, Copy } from "lucide-react"
import { useMemo, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type Message,
  type SearchToolName,
  type ToolInvocationStatus,
} from "@/lib/shared"

import { Button } from "../../ui/button"
import { Source, SourceContent, SourceTrigger } from "../../ui/source"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { MemoizedMarkdown } from "../markdown/memoized-markdown"
import {
  getDedupedSources,
  normalizeAssistantActivityTimeline,
} from "./assistant-activity-timeline"

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

function getSearchToolLabel(toolName: SearchToolName): string {
  if (toolName === "web_search") {
    return "Web"
  }

  if (toolName === "x_search") {
    return "X"
  }

  return "Tavily"
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

export function AssistantMessage({ message }: { message: Message }) {
  const content = useMemo(() => getAssistantContent(message), [message])
  const [activityVisibility, setActivityVisibility] = useState<
    "auto" | "expanded" | "collapsed"
  >("auto")

  const isAssistantStreaming = message.metadata?.isStreaming === true

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

  const hasContent = content.trim().length > 0
  const hasActivity = activityTimeline.length > 0
  const showActivitySection = hasActivity
  const isActivityShimmering =
    hasRunningActivity || (isAssistantStreaming && !hasContent)
  const isActivityCollapsed =
    activityVisibility === "collapsed" ||
    (activityVisibility === "auto" && !hasActiveActivity)

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
                    return hasActiveActivity ? "collapsed" : "expanded"
                  }

                  return current === "collapsed" ? "expanded" : "collapsed"
                })
              }}
            >
              <span className={isActivityShimmering ? "shimmer" : undefined}>
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
                if (entry.kind === "reasoning") {
                  return (
                    <div
                      key={entry.id}
                      className="rounded-none border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
                    >
                      <div className="leading-relaxed whitespace-pre-wrap">
                        {entry.text}
                      </div>
                    </div>
                  )
                }

                if (entry.kind === "search") {
                  const showSearchToolLabel = entry.toolName !== "web_search"
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
