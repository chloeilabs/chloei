import { useState } from "react"

import { Source, SourceContent, SourceTrigger } from "@/components/ui/source"
import type { MessageSource } from "@/lib/shared"

const INITIAL_SOURCES_SHOWN = 3

/**
 * Renders deduped sources as a wrapping row of favicon chips, collapsing
 * everything past the first {@link INITIAL_SOURCES_SHOWN} behind a "+N more"
 * toggle. Each chip animates in with a small staggered slide.
 */
export function SourceList({
  sources,
  showFavicon,
}: {
  sources: MessageSource[]
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
