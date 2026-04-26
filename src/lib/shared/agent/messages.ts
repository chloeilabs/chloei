import type { ModelType } from "../llm/models"

interface TextMessagePart {
  type: "text"
  text: string
}

type AssistantMessagePart = TextMessagePart
export const TOOL_NAMES = [
  "web_search",
  "x_search",
  "code_execution",
  "tavily_search",
  "tavily_extract",
  "finance_data",
  "fmp_mcp",
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export const SEARCH_TOOL_NAMES = [
  "web_search",
  "x_search",
  "tavily_search",
] as const satisfies readonly ToolName[]
export type SearchToolName = (typeof SEARCH_TOOL_NAMES)[number]
export type ToolInvocationStatus = "running" | "success" | "error"
export const AGENT_RUN_STATUSES = [
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

export interface MessageSource {
  id: string
  url: string
  title: string
}

export interface ToolRunMetadata {
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

export interface ToolInvocation {
  id: string
  callId: string | null
  toolName: ToolName
  label: string
  query?: string
  status: ToolInvocationStatus
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

interface ActivityTimelineBaseEntry {
  id: string
  order: number
  createdAt: string
}

export interface ToolActivityTimelineEntry extends ActivityTimelineBaseEntry {
  kind: "tool"
  callId: string | null
  toolName: ToolName
  label: string
  status: ToolInvocationStatus
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

export interface SearchActivityTimelineEntry extends ActivityTimelineBaseEntry {
  kind: "search"
  callId: string | null
  toolName: SearchToolName
  query: string
  status: ToolInvocationStatus
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

export interface SourcesActivityTimelineEntry extends ActivityTimelineBaseEntry {
  kind: "sources"
  sources: MessageSource[]
}

export interface ReasoningActivityTimelineEntry extends ActivityTimelineBaseEntry {
  kind: "reasoning"
  text: string
}

export type ActivityTimelineEntry =
  | ToolActivityTimelineEntry
  | SearchActivityTimelineEntry
  | SourcesActivityTimelineEntry
  | ReasoningActivityTimelineEntry

interface InteractionCheckpointFields {
  interactionId?: string
  lastEventId?: string
}

export interface TextDeltaStreamEvent extends InteractionCheckpointFields {
  type: "text_delta"
  delta: string
}

export interface ReasoningDeltaStreamEvent extends InteractionCheckpointFields {
  type: "reasoning_delta"
  delta: string
}

export interface ToolCallStreamEvent extends InteractionCheckpointFields {
  type: "tool_call"
  callId: string | null
  toolName: ToolName
  label: string
  query?: string
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

export interface ToolResultStreamEvent extends InteractionCheckpointFields {
  type: "tool_result"
  callId: string | null
  toolName?: ToolName
  status: Extract<ToolInvocationStatus, "success" | "error">
  operation?: string
  provider?: string
  attempt?: number
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

export interface SourceStreamEvent extends InteractionCheckpointFields {
  type: "source"
  source: MessageSource
}

export interface AgentStatusStreamEvent extends InteractionCheckpointFields {
  type: "agent_status"
  status: AgentRunStatus
}

export type AgentStreamEvent =
  | TextDeltaStreamEvent
  | ReasoningDeltaStreamEvent
  | ToolCallStreamEvent
  | ToolResultStreamEvent
  | SourceStreamEvent
  | AgentStatusStreamEvent

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  llmModel: string
  createdAt: string
  metadata?: MessageMetadata
}

export interface MessageMetadata {
  parts?: AssistantMessagePart[]
  isStreaming?: boolean
  selectedModel?: ModelType
  agentStatus?: AgentRunStatus
  interactionId?: string
  lastEventId?: string
  toolInvocations?: ToolInvocation[]
  reasoning?: string
  activityTimeline?: ActivityTimelineEntry[]
  sources?: MessageSource[]
}

export const isUserMessage = (
  message: Message
): message is Message & { role: "user" } =>
  message.role.toLowerCase() === "user"

const TOOL_NAME_SET: ReadonlySet<ToolName> = new Set(TOOL_NAMES)
const SEARCH_TOOL_NAME_SET: ReadonlySet<SearchToolName> = new Set(
  SEARCH_TOOL_NAMES
)

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && TOOL_NAME_SET.has(value as ToolName)
}

export function isSearchToolName(value: unknown): value is SearchToolName {
  return (
    typeof value === "string" &&
    SEARCH_TOOL_NAME_SET.has(value as SearchToolName)
  )
}

export const isAssistantMessage = (
  message: Message
): message is Message & { role: "assistant" } =>
  message.role.toLowerCase() === "assistant"
