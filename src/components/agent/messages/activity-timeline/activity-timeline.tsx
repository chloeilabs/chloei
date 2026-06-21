import { useMemo, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import type { ActivityTimelineEntry, Message } from "@/lib/shared"
import { cn } from "@/lib/utils"

import { ActivityStepRow } from "./activity-step"
import { SourceList } from "./source-list"
import { TimelineExpandIcon, TimelineFoldIcon } from "./timeline-icons"
import { getActivityTimelineStyles } from "./tokens"
import {
  formatActivityDuration,
  useActivityDuration,
} from "./use-activity-duration"
import { usePacedReveal } from "./use-paced-reveal"

const SHOW_SOURCE_FAVICON = true

/**
 * The collapsible "Thought for Xs · N steps" activity panel, ported from Onyx's
 * agent timeline (`AgentTimeline`): an agent avatar + connector rail on the LEFT
 * (outside the panel), and a tinted panel on the right whose header collapses to
 * "Thought for Xs" / streams the current action, expanding into a paced timeline
 * of reasoning / search / source steps. Mapped onto chloei's
 * `ActivityTimelineEntry` model and dark shadcn tokens.
 *
 * `entries` should be the already-normalized timeline
 * (`normalizeAssistantActivityTimeline`). Renders nothing when empty.
 */
export function ActivityTimeline({
  entries,
  message,
  isStreaming,
  hasContent,
}: {
  entries: ActivityTimelineEntry[]
  message: Message
  isStreaming: boolean
  hasContent: boolean
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const durationMs = useActivityDuration(isStreaming)

  const hasRunningActivity = useMemo(
    () =>
      entries.some(
        (entry) =>
          (entry.kind === "tool" || entry.kind === "search") &&
          entry.status === "running"
      ),
    [entries]
  )

  // Steps cascade in one at a time (200ms) while streaming; all at once after.
  const visibleCount = usePacedReveal(entries.length, { active: isStreaming })

  // Onyx always shows the agent avatar: a bare avatar row for content-only
  // messages (DISPLAY_CONTENT_ONLY) and an avatar + shimmer "Thinking" row
  // before the first step arrives (EMPTY). Render nothing only when there is
  // neither activity, content, nor an active stream.
  if (entries.length === 0) {
    if (!hasContent && !isStreaming) {
      return null
    }

    return (
      <div className="px-3 pt-2">
        <div style={getActivityTimelineStyles()} className="flex flex-col">
          <div className="flex h-[var(--activity-header-row-height)] w-full">
            <div className="flex h-[var(--activity-header-row-height)] w-[var(--activity-rail-width)] shrink-0 items-center justify-center">
              <LogoHover
                forceAnimate={isStreaming}
                size="sm"
                className="text-muted-foreground"
              />
            </div>
            <div className="flex h-full min-w-0 flex-1 items-center px-3">
              {isStreaming && !hasContent ? (
                <span className="shimmer truncate text-sm text-muted-foreground">
                  Thinking
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const hasActiveActivity =
    isStreaming ||
    hasRunningActivity ||
    message.metadata?.agentStatus === "in_progress"
  const isShimmering = hasRunningActivity || (isStreaming && !hasContent)
  const isCollapsed = !isExpanded
  const stepCount = entries.length

  const lastEntry = entries.at(-1)
  const lastEntryHasPreview =
    lastEntry != null &&
    ((lastEntry.kind === "reasoning" && lastEntry.text.length > 0) ||
      lastEntry.kind === "search" ||
      lastEntry.kind === "sources")
  const showPreview = hasActiveActivity && isCollapsed && lastEntryHasPreview

  const runningEntry = entries
    .filter(
      (entry) =>
        (entry.kind === "tool" || entry.kind === "search") &&
        entry.status === "running"
    )
    .at(-1)
  let currentActivityLabel = isStreaming ? "Thinking" : "Working"
  if (runningEntry?.kind === "search") {
    currentActivityLabel = "Searching the web"
  } else if (runningEntry?.kind === "tool") {
    currentActivityLabel = runningEntry.label
  }

  // Live timer drives the streaming header; on a reloaded thread there is no
  // live timer, so fall back to the span of the persisted timeline timestamps
  // (first → last entry) instead of showing "Thought for some time".
  const activitySpanMs = (() => {
    if (entries.length < 2) return null
    let min = Infinity
    let max = -Infinity
    for (const entry of entries) {
      const time = new Date(entry.createdAt).getTime()
      if (!Number.isFinite(time)) continue
      min = Math.min(min, time)
      max = Math.max(max, time)
    }
    const span = max - min
    return span > 0 ? span : null
  })()
  const effectiveDurationMs = durationMs ?? activitySpanMs

  let headerLabel = "Thought for some time"
  if (hasActiveActivity) {
    headerLabel = currentActivityLabel
  } else if (effectiveDurationMs != null) {
    headerLabel = `Thought for ${formatActivityDuration(effectiveDurationMs)}`
  }

  let headerMeta = `${String(stepCount)} ${stepCount === 1 ? "step" : "steps"}`
  if (hasActiveActivity && durationMs != null) {
    headerMeta = formatActivityDuration(durationMs)
  }

  // Onyx tints the header only while actively executing or expanded; collapsed +
  // done is transparent and tints on hover.
  const showTintedHeader = hasActiveActivity || isExpanded

  return (
    <div className="px-3 pt-2">
      <div style={getActivityTimelineStyles()} className="flex flex-col">
        {/* Header row: avatar in the rail column + the collapsible title panel. */}
        <div className="flex h-[var(--activity-header-row-height)] w-full">
          <div className="flex h-[var(--activity-header-row-height)] w-[var(--activity-rail-width)] shrink-0 items-center justify-center">
            <LogoHover
              forceAnimate={hasActiveActivity}
              size="sm"
              className="text-muted-foreground"
            />
          </div>
          <button
            type="button"
            aria-expanded={isExpanded}
            onClick={() => {
              setIsExpanded((prev) => !prev)
            }}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center justify-between gap-2 rounded-t-xl px-3 transition-colors duration-200 hover:bg-muted/30",
              showTintedHeader && "bg-muted/30",
              isCollapsed && !showPreview && "rounded-b-xl"
            )}
          >
            <span
              className={cn(
                "truncate text-sm text-muted-foreground",
                isShimmering && "shimmer"
              )}
            >
              {headerLabel}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground/60">
              <span className="tabular-nums">{headerMeta}</span>
              {isCollapsed ? (
                <TimelineExpandIcon className="size-3" />
              ) : (
                <TimelineFoldIcon className="size-3" />
              )}
            </span>
          </button>
        </div>

        {/* Collapsed-streaming preview: rail spacer + tinted rounded-bottom box. */}
        {showPreview && (
          <div className="flex w-full">
            <div className="w-[var(--activity-rail-width)] shrink-0" />
            <div className="min-w-0 flex-1 rounded-b-xl bg-muted/30 px-3 pb-2">
              {lastEntry.kind === "reasoning" && (
                <div className="line-clamp-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground/60">
                  {lastEntry.text}
                </div>
              )}
              {lastEntry.kind === "search" && (
                <span className="inline-block max-w-full truncate rounded-lg bg-muted/60 px-2 py-1 align-middle text-[13px] text-muted-foreground">
                  {lastEntry.query}
                </span>
              )}
              {lastEntry.kind === "sources" && (
                <SourceList
                  sources={lastEntry.sources}
                  showFavicon={SHOW_SOURCE_FAVICON}
                />
              )}
            </div>
          </div>
        )}

        {/* Expanded timeline: rail + tinted step surfaces, paced reveal. */}
        {isExpanded && (
          <div className="flex animate-in flex-col duration-300 fade-in slide-in-from-top-2">
            {entries.slice(0, visibleCount).map((entry, index) => (
              <ActivityStepRow
                key={entry.id}
                entry={entry}
                isFirst={index === 0}
                isLast={index === entries.length - 1}
                showFavicon={SHOW_SOURCE_FAVICON}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
