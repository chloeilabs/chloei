import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  CloudSun,
  Copy,
  Download,
  LoaderCircle,
  TrendingUp,
} from "lucide-react"
import dynamic from "next/dynamic"
import { useMemo, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type AssistantMessagePart,
  type CodeExecutionArtifactMetadata,
  type Message,
  type SearchToolName,
  type StockCardOutput,
  type TimelineCardOutput,
  type TimelineEvent,
  type ToolInvocationStatus,
  type WeatherCardOutput,
} from "@/lib/shared"

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
    loading: () => (
      <div className="h-5 w-32 animate-pulse rounded-sm bg-muted/50" />
    ),
    ssr: false,
  }
)

function getAssistantContent(message: Message): string {
  const parts = message.metadata?.parts ?? []

  if (parts.length === 0) {
    return message.content
  }

  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")

  return text.length > 0 ? text : message.content
}

function getAssistantParts(message: Message): AssistantMessagePart[] {
  const parts = message.metadata?.parts ?? []
  return parts.length > 0 ? parts : [{ type: "text", text: message.content }]
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

  if (toolName === "parallel_search") {
    return "Parallel"
  }

  if (toolName === "gateway_web_search") {
    return "AI Gateway"
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

function SourceList({
  sources,
  showFavicon,
}: {
  sources: ReturnType<typeof getDedupedSources>
  showFavicon: boolean
}) {
  if (sources.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <Source href={source.url} key={`${source.id}:${source.url}`}>
          <SourceTrigger
            label={source.title}
            showFavicon={showFavicon}
            className="max-w-full"
          />
          <SourceContent
            title={source.title}
            description={source.url}
            showFavicon={showFavicon}
          />
        </Source>
      ))}
    </div>
  )
}

function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${String(sizeBytes)} B`
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function getArtifactFilename(artifactPath: string): string {
  return artifactPath.split(/[\\/]/).filter(Boolean).at(-1) ?? artifactPath
}

type DownloadableArtifact = CodeExecutionArtifactMetadata & { url: string }

function getDownloadableArtifacts(message: Message): DownloadableArtifact[] {
  const artifacts: DownloadableArtifact[] = []
  const seen = new Set<string>()
  const addArtifacts = (
    manifest: CodeExecutionArtifactMetadata[] | undefined
  ) => {
    for (const artifact of manifest ?? []) {
      const artifactUrl = artifact.url
      if (!artifactUrl?.startsWith("/api/agent/artifacts/")) {
        continue
      }

      const key = `${artifactUrl}:${artifact.path}`
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      artifacts.push({ ...artifact, url: artifactUrl })
    }
  }

  for (const invocation of message.metadata?.toolInvocations ?? []) {
    addArtifacts(invocation.artifactManifest)
  }

  for (const entry of message.metadata?.activityTimeline ?? []) {
    if (entry.kind === "tool" || entry.kind === "search") {
      addArtifacts(entry.artifactManifest)
    }
  }

  return artifacts
}

function ArtifactDownloadList({
  artifacts,
}: {
  artifacts: DownloadableArtifact[]
}) {
  if (artifacts.length === 0) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {artifacts.map((artifact) => (
        <a
          className="inline-flex max-w-full items-center gap-1.5 rounded-none border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          download
          href={artifact.url}
          key={`${artifact.url}:${artifact.path}`}
        >
          <Download className="size-3.5 shrink-0" />
          <span className="truncate">
            Download {getArtifactFilename(artifact.path)}
          </span>
          <span className="shrink-0 text-muted-foreground/70">
            {formatArtifactSize(artifact.sizeBytes)}
          </span>
        </a>
      ))}
    </div>
  )
}

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en-US", options).format(value)
}

function formatTemperature(value: number, unit: WeatherCardOutput["unit"]) {
  return `${String(Math.round(value))}°${unit === "fahrenheit" ? "F" : "C"}`
}

function formatMaybeDateTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed)
}

function formatShortDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(parsed)
}

function WeatherCard({ output }: { output: WeatherCardOutput }) {
  return (
    <div className="my-2 max-w-2xl rounded-md border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CloudSun className="size-4 text-vesper-teal" />
            <span>Weather</span>
          </div>
          <div className="mt-1 truncate text-base font-semibold">
            {output.resolvedLocation ?? output.location}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatMaybeDateTime(output.observedAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-3xl font-semibold tracking-normal">
            {formatTemperature(output.temperature, output.unit)}
          </div>
          <div className="text-xs text-muted-foreground">
            {output.condition}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Metric
          label="Feels"
          value={formatNullableTemperature(output.feelsLike, output.unit)}
        />
        <Metric
          label="Humidity"
          value={formatNullablePercent(output.humidity)}
        />
        <Metric
          label="Wind"
          value={formatNullableSpeed(output.windSpeed, output.unit)}
        />
        <Metric label="Provider" value="Open-Meteo" />
      </div>

      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {output.forecast.slice(0, 5).map((day) => (
          <div
            key={day.date}
            className="min-w-0 rounded-none border bg-background/40 px-2 py-2 text-center"
          >
            <div className="truncate text-[11px] text-muted-foreground">
              {formatShortDate(day.date)}
            </div>
            <div className="mt-1 text-xs font-medium">
              {formatTemperature(day.temperatureMax, output.unit)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatTemperature(day.temperatureMin, output.unit)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-none border bg-background/40 px-2 py-1.5">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium">{value}</div>
    </div>
  )
}

function formatNullableTemperature(
  value: number | null | undefined,
  unit: WeatherCardOutput["unit"]
): string {
  return value == null ? "N/A" : formatTemperature(value, unit)
}

function formatNullablePercent(value: number | null | undefined): string {
  return value == null
    ? "N/A"
    : `${formatNumber(value, { maximumFractionDigits: 0 })}%`
}

function formatNullableSpeed(
  value: number | null | undefined,
  unit: WeatherCardOutput["unit"]
): string {
  if (value == null) {
    return "N/A"
  }

  return `${formatNumber(value, { maximumFractionDigits: 0 })} ${unit === "fahrenheit" ? "mph" : "km/h"}`
}

function StockSparkline({ points }: { points: StockCardOutput["history"] }) {
  const path = useMemo(() => {
    const values = points.map((point) => point.close)
    if (values.length < 2) {
      return ""
    }

    const min = Math.min(...values)
    const max = Math.max(...values)
    const spread = max - min || 1
    return values
      .map((value, index) => {
        const x = (index / Math.max(values.length - 1, 1)) * 100
        const y = 32 - ((value - min) / spread) * 28
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(" ")
  }, [points])

  if (!path) {
    return (
      <div className="flex h-10 items-center justify-center border bg-background/40 text-xs text-muted-foreground">
        Chart unavailable
      </div>
    )
  }

  return (
    <svg
      aria-hidden="true"
      className="h-10 w-full overflow-visible"
      preserveAspectRatio="none"
      viewBox="0 0 100 36"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function StockCard({ output }: { output: StockCardOutput }) {
  const change = output.dayChange
  const changeClass =
    change == null
      ? "text-muted-foreground"
      : change >= 0
        ? "text-green-600"
        : "text-red-600"
  const sourceLabel =
    output.provider === "fmp" ? "Financial Modeling Prep" : "Stooq"

  return (
    <div className="my-2 max-w-2xl rounded-md border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <TrendingUp className="size-4 text-vesper-orange" />
            <span>Stock</span>
            <span className="rounded-none border px-1.5 py-0.5 text-[10px] uppercase">
              {output.delayed ? "Delayed" : "Live"}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-baseline gap-2">
            <span className="truncate text-base font-semibold">
              {output.symbol}
            </span>
            {output.name && (
              <span className="truncate text-xs text-muted-foreground">
                {output.name}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatMaybeDateTime(output.asOf)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-semibold tracking-normal">
            {formatCurrency(output.price, output.currency)}
          </div>
          <div className={`text-xs ${changeClass}`}>
            {formatStockChange(output)}
          </div>
        </div>
      </div>

      <div className={`mt-3 ${changeClass}`}>
        <StockSparkline points={output.history} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Metric
          label="Open"
          value={formatNullableCurrency(output.open, output.currency)}
        />
        <Metric
          label="High"
          value={formatNullableCurrency(output.high, output.currency)}
        />
        <Metric
          label="Low"
          value={formatNullableCurrency(output.low, output.currency)}
        />
        <Metric label="Volume" value={formatNullableCompact(output.volume)} />
        <Metric label="Source" value={sourceLabel} />
      </div>
    </div>
  )
}

function formatCurrency(value: number, currency = "USD"): string {
  return formatNumber(value, {
    currency,
    maximumFractionDigits: value >= 100 ? 2 : 4,
    minimumFractionDigits: 2,
    style: "currency",
  })
}

function formatNullableCurrency(
  value: number | null | undefined,
  currency?: string
): string {
  return value == null ? "N/A" : formatCurrency(value, currency)
}

function formatNullableCompact(value: number | null | undefined): string {
  return value == null
    ? "N/A"
    : formatNumber(value, {
        notation: "compact",
        maximumFractionDigits: 1,
      })
}

function formatStockChange(output: StockCardOutput): string {
  if (output.dayChange == null) {
    return "Change N/A"
  }

  const sign = output.dayChange >= 0 ? "+" : ""
  const percent =
    output.dayChangePercent == null
      ? ""
      : ` (${sign}${formatNumber(output.dayChangePercent, { maximumFractionDigits: 2 })}%)`

  return `${sign}${formatCurrency(output.dayChange, output.currency)}${percent}`
}

function getIsoDateAttr(value: string): string | undefined {
  const trimmed = value.trim()
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(trimmed)) {
    return trimmed
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString().slice(0, 10)
}

function getEventYear(value: string): string | null {
  const match = /\b(\d{4})\b/.exec(value)
  return match ? (match[1] ?? null) : null
}

function getEventDateWithoutYear(value: string, year: string): string {
  const withoutYear = value
    .replace(new RegExp(`^${year}[-/.\\s]*`), "")
    .replace(new RegExp(`[,\\s]+${year}\\b\\.?\\s*$`), "")
    .replace(new RegExp(`\\b${year}\\b`), "")
    .replace(/\s+/g, " ")
    .replace(/^[,–\-\s]+|[,–\-\s]+$/g, "")
    .trim()
  return withoutYear || value
}

interface TimelineYearGroup {
  year: string | null
  events: { event: TimelineEvent; originalIndex: number }[]
}

function groupTimelineEventsByYear(
  events: TimelineEvent[]
): TimelineYearGroup[] {
  const groups: TimelineYearGroup[] = []
  events.forEach((event, originalIndex) => {
    const year = getEventYear(event.date)
    const last = groups[groups.length - 1]
    if (last?.year === year) {
      last.events.push({ event, originalIndex })
    } else {
      groups.push({ year, events: [{ event, originalIndex }] })
    }
  })
  return groups
}

function TimelineCard({ output }: { output: TimelineCardOutput }) {
  const yearGroups = useMemo(
    () => groupTimelineEventsByYear(output.events),
    [output.events]
  )
  const hasYearGroups = yearGroups.some((group) => group.year !== null)

  return (
    <div className="my-2 max-w-2xl rounded-md border bg-muted/30 p-4">
      <div className="flex items-center gap-1.5 font-departureMono text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
        <CalendarClock className="size-3.5 text-vesper-teal" />
        <span>Timeline</span>
      </div>
      <div className="mt-2 text-base leading-tight font-semibold tracking-tight">
        {output.title}
      </div>
      {output.subtitle && (
        <div className="mt-1 text-xs text-muted-foreground">
          {output.subtitle}
        </div>
      )}

      <div
        aria-label={`${output.title} timeline`}
        className="relative mt-4 ml-[5px] pl-5"
        role="list"
      >
        <span
          aria-hidden="true"
          className="absolute top-1 bottom-1 left-0 w-[2px] rounded-full bg-gradient-to-b from-vesper-teal/60 via-border to-border/40"
        />

        {yearGroups.map((group, groupIndex) => (
          <section
            key={`${group.year ?? "year-unknown"}-${String(groupIndex)}`}
            className={groupIndex === 0 ? "" : "mt-5"}
          >
            {group.year && hasYearGroups && (
              <h4 className="-mt-0.5 mb-2 font-departureMono text-[11px] font-semibold tracking-[0.12em] text-vesper-teal uppercase">
                {group.year}
              </h4>
            )}
            <ol className="space-y-3.5">
              {group.events.map(({ event, originalIndex }) => {
                const isoDate = getIsoDateAttr(event.date)
                const displayDate =
                  group.year && hasYearGroups
                    ? getEventDateWithoutYear(event.date, group.year)
                    : event.date
                return (
                  <li
                    key={`${event.date}-${String(originalIndex)}`}
                    className="relative"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute top-[5px] -left-[1.6875rem] size-2.5 rounded-full border-2 border-border bg-vesper-teal"
                    />
                    <time
                      className="font-departureMono text-[10px] tracking-[0.08em] text-muted-foreground/90 uppercase"
                      {...(isoDate ? { dateTime: isoDate } : {})}
                    >
                      {displayDate}
                    </time>
                    <div className="mt-0.5 text-sm leading-snug font-medium text-foreground">
                      {event.sourceUrl ? (
                        <a
                          className="underline decoration-border underline-offset-[3px] transition-colors hover:decoration-foreground"
                          href={event.sourceUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {event.label}
                        </a>
                      ) : (
                        event.label
                      )}
                    </div>
                    {event.description && (
                      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {event.description}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}

function GenerativeUiLoading({ label }: { label: string }) {
  return (
    <div className="my-2 flex max-w-2xl items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-3.5 animate-spin" />
      <span className="shimmer">{label}</span>
    </div>
  )
}

function GenerativeUiError({ errorText }: { errorText: string }) {
  return (
    <div className="my-2 flex max-w-2xl items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span>{errorText}</span>
    </div>
  )
}

function AssistantMessagePartRenderer({
  messageId,
  part,
  partIndex,
  showSourceFavicon,
  sources,
}: {
  messageId: string
  part: AssistantMessagePart
  partIndex: number
  showSourceFavicon: boolean
  sources: ReturnType<typeof getDedupedSources>
}) {
  if (part.type === "text") {
    if (!part.text.trim()) {
      return null
    }

    return (
      <MemoizedMarkdown
        content={part.text}
        id={`${messageId}-text-${String(partIndex)}`}
        showSourceFavicon={showSourceFavicon}
        sources={sources}
      />
    )
  }

  if (part.type === "tool-display_weather") {
    if (part.state === "input-available") {
      return (
        <GenerativeUiLoading
          label={`Loading weather for ${part.input.location}`}
        />
      )
    }

    if (part.state === "output-error") {
      return <GenerativeUiError errorText={part.errorText} />
    }

    return <WeatherCard output={part.output} />
  }

  if (part.type === "tool-display_stock") {
    if (part.state === "input-available") {
      return (
        <GenerativeUiLoading label={`Loading quote for ${part.input.symbol}`} />
      )
    }

    if (part.state === "output-error") {
      return <GenerativeUiError errorText={part.errorText} />
    }

    return <StockCard output={part.output} />
  }

  if (part.state === "input-available") {
    return (
      <GenerativeUiLoading label={`Loading timeline for ${part.input.title}`} />
    )
  }

  if (part.state === "output-error") {
    return <GenerativeUiError errorText={part.errorText} />
  }

  return <TimelineCard output={part.output} />
}

export function AssistantMessage({ message }: { message: Message }) {
  const content = useMemo(() => getAssistantContent(message), [message])
  const messageParts = useMemo(() => getAssistantParts(message), [message])
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
  const downloadableArtifacts = useMemo(
    () => getDownloadableArtifacts(message),
    [message]
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
  const hasGenerativeParts = messageParts.some((part) => part.type !== "text")
  const hasActivity = activityTimeline.length > 0
  const showActivitySection = hasActivity
  const isActivityShimmering =
    hasRunningActivity || (isAssistantStreaming && !hasContent)
  const isActivityCollapsed =
    activityVisibility === "collapsed" ||
    (activityVisibility === "auto" && !hasActiveActivity)

  if (!hasContent && !hasGenerativeParts && !hasActivity) {
    return null
  }

  return (
    <div
      data-message-role="assistant"
      data-streaming={isAssistantStreaming ? "true" : "false"}
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
                      <SourceList
                        sources={entry.sources}
                        showFavicon={showSourceFavicon}
                      />
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

      {(hasContent || hasGenerativeParts) && (
        <div className="px-3 py-2 text-sm">
          <div className="flex flex-col gap-1">
            {messageParts.map((part, index) => (
              <AssistantMessagePartRenderer
                key={
                  part.type === "text"
                    ? `${message.id}-text-${String(index)}`
                    : `${part.type}-${part.toolCallId}`
                }
                messageId={message.id}
                part={part}
                partIndex={index}
                showSourceFavicon={showSourceFavicon}
                sources={sources}
              />
            ))}
          </div>
          <ArtifactDownloadList artifacts={downloadableArtifacts} />
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
