import { CircleX, Wrench } from "lucide-react"
import Image from "next/image"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import type { ActivityTimelineEntry } from "@/lib/shared"
import { cn } from "@/lib/utils"

import { SourceList } from "./source-list"
import { TimelineCircleIcon, TimelineGlobeIcon } from "./timeline-icons"

export type ActivityEntry = ActivityTimelineEntry

/** Header label shown next to a step's icon. */
export function activityStepLabel(entry: ActivityEntry): string {
  switch (entry.kind) {
    case "reasoning":
      return "Thinking"
    case "search":
      return entry.status === "running"
        ? "Searching the web"
        : "Searched the web"
    case "sources":
      return "Sources"
    case "subagent":
      return `Goblin: ${entry.label}`
    default:
      return entry.label
  }
}

/** The dot/glyph drawn on the rail for a given step. */
export function ActivityStepIcon({ entry }: { entry: ActivityEntry }) {
  // Goblins (sub-agents) get their own on-brand icon — pulsing while running,
  // a red cross on failure — so they read distinctly from web searches/tools.
  if (entry.kind === "subagent") {
    if (entry.status === "error") {
      return <CircleX className="size-3 text-destructive" />
    }
    return (
      <Image
        src="/goblin.png"
        alt=""
        width={16}
        height={16}
        unoptimized
        aria-hidden="true"
        className={cn(
          "size-4 rounded-sm",
          entry.status === "running" && "animate-pulse"
        )}
      />
    )
  }

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

  if (
    entry.kind === "search" ||
    (entry.kind === "tool" && entry.toolName === "web_search")
  ) {
    return <TimelineGlobeIcon className="size-3 text-muted-foreground" />
  }

  // Onyx renders the fetch step (which surfaces sources) with the same circle.
  if (entry.kind === "sources" || entry.kind === "reasoning") {
    return <TimelineCircleIcon className="size-3 text-muted-foreground" />
  }

  return <Wrench className="size-3 text-muted-foreground" />
}

function hasStepBody(entry: ActivityEntry): boolean {
  return (
    (entry.kind === "reasoning" && entry.text.length > 0) ||
    entry.kind === "search" ||
    entry.kind === "sources" ||
    (entry.kind === "subagent" && Boolean(entry.task))
  )
}

/**
 * Renders the kind-specific body under a step's header (reasoning text, the
 * search query chip, or the source chips). Reasoning is shown as plain text on
 * purpose — chloei's `normalizeThinkingEntry` strips markdown upstream.
 */
function ActivityStepBody({
  entry,
  showFavicon,
}: {
  entry: ActivityEntry
  showFavicon: boolean
}) {
  if (entry.kind === "reasoning" && entry.text.length > 0) {
    return (
      <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground/60">
        {entry.text}
      </div>
    )
  }

  if (entry.kind === "search") {
    return (
      <span className="inline-block max-w-full animate-in truncate rounded-lg bg-muted/60 px-2 py-1 align-middle text-[13px] text-muted-foreground duration-150 fade-in">
        {entry.query}
      </span>
    )
  }

  if (entry.kind === "sources") {
    return <SourceList sources={entry.sources} showFavicon={showFavicon} />
  }

  if (entry.kind === "subagent" && entry.task) {
    return (
      <div className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground/60">
        {entry.task}
      </div>
    )
  }

  return null
}

/**
 * One step in the expanded timeline — Onyx's `StepContainer` shape: a rail
 * (connector segments + centered icon) on the LEFT, OUTSIDE the tinted surface,
 * and the surface (label + body) on the right. Surfaces are always tinted so
 * the header + stacked steps read as one continuous panel beside the rail.
 * Geometry comes from the `--activity-*` CSS variables (see tokens.ts).
 */
export function ActivityStepRow({
  entry,
  isFirst,
  isLast,
  showFavicon,
}: {
  entry: ActivityEntry
  isFirst: boolean
  isLast: boolean
  showFavicon: boolean
}) {
  const body = hasStepBody(entry)
  // Onyx gives reasoning content full width (noPaddingRight); other steps
  // reserve the right-section column.
  const noPaddingRight = entry.kind === "reasoning"

  return (
    <div className="flex w-full animate-in duration-200 fade-in">
      {/* Rail: connector above + icon + connector below (Onyx TimelineIconColumn). */}
      <div className="relative flex w-[var(--activity-rail-width)] shrink-0 flex-col items-center">
        <div className="flex h-[var(--activity-step-header-height)] w-full flex-col items-center">
          <div
            className={cn(
              "h-[var(--activity-top-connector-height)] w-px",
              !isFirst && "bg-border"
            )}
          />
          <div className="flex size-[var(--activity-icon-wrapper-size)] shrink-0 items-center justify-center">
            <ActivityStepIcon entry={entry} />
          </div>
          <div className={cn("w-px flex-1", !isLast && "bg-border")} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>

      {/* Surface: tinted content (Onyx TimelineSurface + TimelineStepContent). */}
      <div
        className={cn(
          "min-w-0 flex-1 bg-muted/30 transition-colors duration-200",
          isLast && "rounded-b-xl"
        )}
      >
        <div className="flex flex-col px-1 pb-1">
          <div className="flex h-[var(--activity-step-header-height)] items-center pl-1">
            <span className="truncate text-[13px] text-muted-foreground/80">
              {activityStepLabel(entry)}
            </span>
          </div>
          {body && (
            <div
              className={cn(
                "pb-1 pl-1",
                !noPaddingRight && "pr-[var(--activity-right-section-width)]"
              )}
            >
              <ActivityStepBody entry={entry} showFavicon={showFavicon} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
