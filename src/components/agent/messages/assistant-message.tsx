import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Download,
} from "lucide-react"
import dynamic from "next/dynamic"
import { useMemo, useState } from "react"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import {
  type CodeExecutionArtifactMetadata,
  type Message,
  type SearchToolName,
  type ToolInvocationStatus,
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

      {hasContent && (
        <div className="px-3 py-2 text-sm">
          <MemoizedMarkdown
            content={content}
            id={`${message.id}-text`}
            showSourceFavicon={showSourceFavicon}
            sources={sources}
          />
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
