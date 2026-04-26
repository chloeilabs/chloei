import {
  type ActivityTimelineEntry,
  type AgentRunStatus,
  type AgentStreamEvent,
  isSearchToolName,
  type MessageSource,
  type ToolInvocation,
  type ToolRunMetadata,
} from "@/lib/shared"

import { createClientMessageId } from "./home-agent-utils"

type ToolCallEvent = Extract<AgentStreamEvent, { type: "tool_call" }>
type ToolResultEvent = Extract<AgentStreamEvent, { type: "tool_result" }>
type ToolActivityTimelineEntry = Extract<
  ActivityTimelineEntry,
  { kind: "tool" }
>
type SearchActivityTimelineEntry = Extract<
  ActivityTimelineEntry,
  { kind: "search" }
>
type SourcesActivityTimelineEntry = Extract<
  ActivityTimelineEntry,
  { kind: "sources" }
>
type ReasoningActivityTimelineEntry = Extract<
  ActivityTimelineEntry,
  { kind: "reasoning" }
>

function getSearchQueryFromToolCall(event: ToolCallEvent): string | null {
  if (!isSearchToolName(event.toolName)) {
    return null
  }

  const normalizedQuery = event.query?.trim()
  if (normalizedQuery) {
    return normalizedQuery
  }

  const normalizedLabel = event.label.trim()
  return normalizedLabel.length > 0 ? normalizedLabel : null
}

function getToolRunMetadata(
  event: ToolCallEvent | ToolResultEvent
): ToolRunMetadata {
  return {
    ...(event.operation ? { operation: event.operation } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.attempt ? { attempt: event.attempt } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
  }
}

export interface AgentStreamAccumulator {
  content: string
  reasoning: string
  agentStatus?: AgentRunStatus
  interactionId?: string
  lastEventId?: string
  toolInvocations: ToolInvocation[]
  activityTimeline: ActivityTimelineEntry[]
  sources: MessageSource[]
  nextActivityOrder: number
}

export function createAgentStreamAccumulator(): AgentStreamAccumulator {
  return {
    content: "",
    reasoning: "",
    agentStatus: undefined,
    interactionId: undefined,
    lastEventId: undefined,
    toolInvocations: [],
    activityTimeline: [],
    sources: [],
    nextActivityOrder: 0,
  }
}

export function appendRawStreamText(
  current: AgentStreamAccumulator,
  text: string
): AgentStreamAccumulator {
  if (text.length === 0) {
    return current
  }

  return {
    ...current,
    content: `${current.content}${text}`,
  }
}

export function applyAgentStreamEvent(
  current: AgentStreamAccumulator,
  event: AgentStreamEvent
): AgentStreamAccumulator {
  const checkpointFields = getCheckpointFields(current, event)
  let nextActivityOrder = current.nextActivityOrder
  const nextOrder = () => {
    const next = nextActivityOrder
    nextActivityOrder += 1
    return next
  }

  if (event.type === "text_delta") {
    return {
      ...current,
      ...checkpointFields,
      content: `${current.content}${event.delta}`,
    }
  }

  if (event.type === "source") {
    const nextSources = upsertSource(current.sources, event.source)
    return {
      ...current,
      ...checkpointFields,
      sources: nextSources,
      activityTimeline: upsertSourcesTimelineFromSource(
        current.activityTimeline,
        event.source,
        nextOrder
      ),
      nextActivityOrder,
    }
  }

  if (event.type === "agent_status") {
    return {
      ...current,
      ...checkpointFields,
      agentStatus: event.status,
    }
  }

  if (event.type === "reasoning_delta") {
    return {
      ...current,
      ...checkpointFields,
      reasoning: `${current.reasoning}${event.delta}`,
      activityTimeline: appendReasoningToTimeline(
        current.activityTimeline,
        event.delta,
        nextOrder
      ),
      nextActivityOrder,
    }
  }

  if (event.type === "tool_call") {
    return {
      ...current,
      ...checkpointFields,
      toolInvocations: upsertToolInvocationFromCall(
        current.toolInvocations,
        event
      ),
      activityTimeline: upsertToolTimelineFromCall(
        current.activityTimeline,
        event,
        nextOrder
      ),
      nextActivityOrder,
    }
  }

  return {
    ...current,
    ...checkpointFields,
    toolInvocations: applyToolResultToInvocations(
      current.toolInvocations,
      event
    ),
    activityTimeline: applyToolResultToTimeline(
      current.activityTimeline,
      event
    ),
  }
}

export function finalizeAgentStreamAccumulator(
  current: AgentStreamAccumulator,
  status: "success" | "error"
): AgentStreamAccumulator {
  return {
    ...current,
    toolInvocations: finalizeRunningInvocations(
      current.toolInvocations,
      status
    ),
    activityTimeline: finalizeRunningTimelineToolEntries(
      current.activityTimeline,
      status
    ),
  }
}

export function hasAgentStreamOutput(current: AgentStreamAccumulator): boolean {
  return Boolean(
    current.content.trim() ||
    current.reasoning.trim() ||
    current.agentStatus != null ||
    current.toolInvocations.length > 0 ||
    current.activityTimeline.length > 0 ||
    current.sources.length > 0
  )
}

function getCheckpointFields(
  current: AgentStreamAccumulator,
  event: AgentStreamEvent
): Pick<AgentStreamAccumulator, "interactionId" | "lastEventId"> {
  return {
    interactionId: event.interactionId ?? current.interactionId,
    lastEventId: event.lastEventId ?? current.lastEventId,
  }
}

function upsertToolInvocationFromCall(
  current: ToolInvocation[],
  event: ToolCallEvent
): ToolInvocation[] {
  const searchQuery = getSearchQueryFromToolCall(event)
  const existingIndex =
    event.callId !== null
      ? current.findIndex((invocation) => invocation.callId === event.callId)
      : current.findIndex(
          (invocation) =>
            invocation.callId === null &&
            invocation.toolName === event.toolName &&
            (searchQuery
              ? invocation.query === searchQuery
              : invocation.label === event.label)
        )

  if (existingIndex === -1) {
    return [
      ...current,
      {
        id: createClientMessageId(),
        callId: event.callId,
        toolName: event.toolName,
        label: event.label,
        ...(searchQuery ? { query: searchQuery } : {}),
        ...getToolRunMetadata(event),
        status: "running",
      },
    ]
  }

  const existing = current[existingIndex]
  if (!existing) {
    return current
  }

  const nextStatus =
    existing.status === "success" || existing.status === "error"
      ? existing.status
      : "running"

  const nextInvocation: ToolInvocation = {
    ...existing,
    toolName: event.toolName,
    label: event.label,
    callId: event.callId,
    ...((searchQuery ?? existing.query)
      ? { query: searchQuery ?? existing.query }
      : {}),
    ...getToolRunMetadata(event),
    status: nextStatus,
  }

  const updated = [...current]
  updated[existingIndex] = nextInvocation
  return updated
}

function applyToolResultToInvocations(
  current: ToolInvocation[],
  event: ToolResultEvent
): ToolInvocation[] {
  const targetIndex =
    event.callId !== null
      ? findLastIndexBy(
          current,
          (invocation) => invocation.callId === event.callId
        )
      : findLastIndexBy(
          current,
          (invocation) => invocation.status === "running"
        )

  if (targetIndex === -1) {
    return current
  }

  const target = current[targetIndex]
  if (!target || target.status === event.status) {
    return current
  }

  const updated = [...current]
  updated[targetIndex] = {
    ...target,
    ...getToolRunMetadata(event),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    status: event.status,
  }
  return updated
}

function finalizeRunningInvocations(
  current: ToolInvocation[],
  status: "success" | "error"
): ToolInvocation[] {
  if (!current.some((invocation) => invocation.status === "running")) {
    return current
  }

  return current.map((invocation) =>
    invocation.status === "running" ? { ...invocation, status } : invocation
  )
}

function upsertToolTimelineFromCall(
  current: ActivityTimelineEntry[],
  event: ToolCallEvent,
  nextOrder: () => number
): ActivityTimelineEntry[] {
  const searchQuery = getSearchQueryFromToolCall(event)
  if (isSearchToolName(event.toolName) && searchQuery) {
    const existingIndex =
      event.callId !== null
        ? current.findIndex(
            (entry) =>
              entry.kind === "search" &&
              entry.callId !== null &&
              entry.callId === event.callId
          )
        : current.findIndex(
            (entry) =>
              entry.kind === "search" &&
              entry.callId === null &&
              entry.toolName === event.toolName &&
              entry.query === searchQuery
          )

    if (existingIndex === -1) {
      const nextEntry: SearchActivityTimelineEntry = {
        id: createClientMessageId(),
        kind: "search",
        order: nextOrder(),
        createdAt: new Date().toISOString(),
        callId: event.callId,
        toolName: event.toolName,
        query: searchQuery,
        ...getToolRunMetadata(event),
        status: "running",
      }

      return [...current, nextEntry]
    }

    const existing = current[existingIndex]
    if (existing?.kind !== "search") {
      return current
    }

    const nextStatus =
      existing.status === "success" || existing.status === "error"
        ? existing.status
        : "running"

    const updatedEntry: SearchActivityTimelineEntry = {
      ...existing,
      callId: event.callId,
      toolName: event.toolName,
      query: searchQuery,
      ...getToolRunMetadata(event),
      status: nextStatus,
    }

    const updated = [...current]
    updated[existingIndex] = updatedEntry
    return updated
  }

  const existingIndex =
    event.callId !== null
      ? current.findIndex(
          (entry) =>
            entry.kind === "tool" &&
            entry.callId !== null &&
            entry.callId === event.callId
        )
      : current.findIndex(
          (entry) =>
            entry.kind === "tool" &&
            entry.callId === null &&
            entry.toolName === event.toolName &&
            entry.label === event.label
        )

  if (existingIndex === -1) {
    const nextEntry: ToolActivityTimelineEntry = {
      id: createClientMessageId(),
      kind: "tool",
      order: nextOrder(),
      createdAt: new Date().toISOString(),
      callId: event.callId,
      toolName: event.toolName,
      label: event.label,
      ...getToolRunMetadata(event),
      status: "running",
    }

    return [...current, nextEntry]
  }

  const existing = current[existingIndex]
  if (existing?.kind !== "tool") {
    return current
  }

  const nextStatus =
    existing.status === "success" || existing.status === "error"
      ? existing.status
      : "running"

  const updatedEntry: ToolActivityTimelineEntry = {
    ...existing,
    callId: event.callId,
    toolName: event.toolName,
    label: event.label,
    ...getToolRunMetadata(event),
    status: nextStatus,
  }

  const updated = [...current]
  updated[existingIndex] = updatedEntry
  return updated
}

function applyToolResultToTimeline(
  current: ActivityTimelineEntry[],
  event: ToolResultEvent
): ActivityTimelineEntry[] {
  const targetIndex =
    event.callId !== null
      ? findLastIndexBy(
          current,
          (entry) =>
            (entry.kind === "tool" || entry.kind === "search") &&
            entry.callId !== null &&
            entry.callId === event.callId
        )
      : findLastIndexBy(
          current,
          (entry) =>
            (entry.kind === "tool" || entry.kind === "search") &&
            entry.status === "running"
        )

  if (targetIndex === -1) {
    return current
  }

  const target = current[targetIndex]
  if (
    !target ||
    (target.kind !== "tool" && target.kind !== "search") ||
    target.status === event.status
  ) {
    return current
  }

  const updated = [...current]
  updated[targetIndex] =
    target.kind === "tool"
      ? {
          ...target,
          ...getToolRunMetadata(event),
          ...(event.toolName ? { toolName: event.toolName } : {}),
          status: event.status,
        }
      : {
          ...target,
          ...getToolRunMetadata(event),
          status: event.status,
        }
  return updated
}

function upsertSourcesTimelineFromSource(
  current: ActivityTimelineEntry[],
  source: MessageSource,
  nextOrder: () => number
): ActivityTimelineEntry[] {
  const lastEntry = current[current.length - 1]
  if (lastEntry?.kind === "sources") {
    const updatedLast: SourcesActivityTimelineEntry = {
      ...lastEntry,
      sources: upsertSource(lastEntry.sources, source),
    }

    return [...current.slice(0, -1), updatedLast]
  }

  const nextEntry: SourcesActivityTimelineEntry = {
    id: createClientMessageId(),
    kind: "sources",
    order: nextOrder(),
    createdAt: new Date().toISOString(),
    sources: [source],
  }

  return [...current, nextEntry]
}

function upsertSource(
  current: MessageSource[],
  source: MessageSource
): MessageSource[] {
  const existingIndex = current.findIndex(
    (candidate) => candidate.url === source.url
  )

  if (existingIndex === -1) {
    return [...current, source]
  }

  const existing = current[existingIndex]
  if (!existing) {
    return current
  }

  const updated = [...current]
  updated[existingIndex] = {
    ...existing,
    title:
      existing.title === existing.url && source.title !== source.url
        ? source.title
        : existing.title,
  }
  return updated
}

function appendReasoningToTimeline(
  current: ActivityTimelineEntry[],
  delta: string,
  nextOrder: () => number
): ActivityTimelineEntry[] {
  const mergeReasoningText = (
    currentText: string,
    nextText: string
  ): string => {
    if (currentText.length === 0 || nextText.length === 0) {
      return `${currentText}${nextText}`
    }

    if (/\s$/.test(currentText) || /^\s/.test(nextText)) {
      return `${currentText}${nextText}`
    }

    if (/[A-Za-z0-9)]$/.test(currentText) && /^[A-Za-z0-9(]/.test(nextText)) {
      return `${currentText} ${nextText}`
    }

    return `${currentText}${nextText}`
  }

  const normalizeReasoningText = (text: string): string =>
    text
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()

  if (delta.length === 0) {
    return current
  }

  const lastEntry = current[current.length - 1]
  if (lastEntry?.kind === "reasoning") {
    const mergedText = normalizeReasoningText(
      mergeReasoningText(lastEntry.text, delta)
    )
    if (mergedText.length === 0) {
      return current.slice(0, -1)
    }

    const updatedLast: ReasoningActivityTimelineEntry = {
      ...lastEntry,
      text: mergedText,
    }

    return [...current.slice(0, -1), updatedLast]
  }

  const initialText = normalizeReasoningText(delta)
  if (initialText.length === 0) {
    return current
  }

  const nextEntry: ReasoningActivityTimelineEntry = {
    id: createClientMessageId(),
    kind: "reasoning",
    order: nextOrder(),
    createdAt: new Date().toISOString(),
    text: initialText,
  }

  return [...current, nextEntry]
}

function finalizeRunningTimelineToolEntries(
  current: ActivityTimelineEntry[],
  status: "success" | "error"
): ActivityTimelineEntry[] {
  if (
    !current.some(
      (entry) =>
        (entry.kind === "tool" || entry.kind === "search") &&
        entry.status === "running"
    )
  ) {
    return current
  }

  return current.map((entry) =>
    (entry.kind === "tool" || entry.kind === "search") &&
    entry.status === "running"
      ? { ...entry, status }
      : entry
  )
}

function findLastIndexBy<T>(
  current: T[],
  predicate: (entry: T) => boolean
): number {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const entry = current[index]
    if (entry && predicate(entry)) {
      return index
    }
  }

  return -1
}
