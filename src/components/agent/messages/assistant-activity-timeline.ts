import {
  type ActivityTimelineEntry,
  isSearchToolName,
  type Message,
  type MessageSource,
} from "@/lib/shared"

function isRedactedReasoningEntry(text: string): boolean {
  return text.trim() === "[REDACTED]"
}

export function normalizeThinkingEntry(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n][^*\n]*)\*\*/g, "$1")
    .replace(/^\s*(thinking|reasoning)\s*:\s*/i, "")
    .replace(/^\s*(thinking|reasoning)\s*\n+/i, "")
    .replace(/^\s*(thinking|reasoning)\s*:?\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function getDedupedSources(
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

function toReasoningEntries(reasoning: string): string[] {
  const normalized = normalizeThinkingEntry(reasoning)
  if (!normalized) {
    return []
  }

  return normalized
    .split(/\n{2,}/)
    .map((entry) => normalizeThinkingEntry(entry))
    .filter((entry) => entry.length > 0 && !isRedactedReasoningEntry(entry))
}

function appendMissingSourcesToTimeline(
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

  const nextOrder =
    timeline.reduce((maxOrder, entry) => Math.max(maxOrder, entry.order), -1) +
    1

  return [
    ...timeline,
    {
      id: `${createdAt}-sources`,
      kind: "sources",
      order: nextOrder,
      createdAt,
      sources,
    },
  ]
}

export function normalizeAssistantActivityTimeline(
  message: Message
): ActivityTimelineEntry[] {
  const dedupedSources = getDedupedSources(message.metadata?.sources)
  const timeline = message.metadata?.activityTimeline

  if (Array.isArray(timeline) && timeline.length > 0) {
    const normalizedTimeline = [...timeline]
      .sort((left, right) => left.order - right.order)
      .reduce<ActivityTimelineEntry[]>((entries, entry) => {
        if (entry.kind === "reasoning") {
          const normalizedText = normalizeThinkingEntry(entry.text)
          if (
            normalizedText.length === 0 ||
            isRedactedReasoningEntry(normalizedText)
          ) {
            return entries
          }

          entries.push({ ...entry, text: normalizedText })
          return entries
        }

        if (entry.kind === "sources") {
          const normalizedSources = getDedupedSources(entry.sources)
          if (normalizedSources.length === 0) {
            return entries
          }

          entries.push({ ...entry, sources: normalizedSources })
          return entries
        }

        if (entry.kind === "tool" && isSearchToolName(entry.toolName)) {
          const query = entry.label.trim()
          if (!query) {
            entries.push(entry)
            return entries
          }

          entries.push({
            id: entry.id,
            kind: "search",
            order: entry.order,
            createdAt: entry.createdAt,
            callId: entry.callId,
            toolName: entry.toolName,
            query,
            status: entry.status,
          })
          return entries
        }

        entries.push(entry)
        return entries
      }, [])

    return appendMissingSourcesToTimeline(
      normalizedTimeline,
      dedupedSources,
      message.createdAt
    )
  }

  const fallback: ActivityTimelineEntry[] = []
  const reasoningEntries = toReasoningEntries(message.metadata?.reasoning ?? "")
  const toolInvocations = message.metadata?.toolInvocations ?? []

  let order = 0

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

  return appendMissingSourcesToTimeline(
    fallback,
    dedupedSources,
    message.createdAt
  )
}
