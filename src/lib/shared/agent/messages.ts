import type { ModelType } from "../llm/models"

interface TextMessagePart {
  type: "text"
  text: string
}

type AssistantMessagePart = TextMessagePart

export interface FollowUpQuestion {
  id: string
  text: string
}

// exa_* are Exa function tools; web_search is OpenAI's hosted web-search tool.
export const TOOL_NAMES = [
  "exa_search",
  "exa_get_contents",
  "web_search",
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

// Goblins-mode sub-agents. These are NOT tools (kept out of ToolName); the
// GPT-5.5 manager delegates to them via the Agents SDK `asTool` pattern, and the
// server surfaces their lifecycle as subagent_call / subagent_result events.
export const SUBAGENT_IDS = [
  "goblin_web_researcher",
  "goblin_source_verifier",
  "goblin_recency_scout",
  "goblin_numbers_analyst",
  "goblin_contrarian",
  "goblin_context_scout",
] as const
export type SubagentId = (typeof SUBAGENT_IDS)[number]

const SUBAGENT_ID_SET: ReadonlySet<SubagentId> = new Set(SUBAGENT_IDS)

export function isSubagentId(value: unknown): value is SubagentId {
  return typeof value === "string" && SUBAGENT_ID_SET.has(value as SubagentId)
}

export const SEARCH_TOOL_NAMES = [
  "exa_search",
] as const satisfies readonly ToolName[]
type SearchToolName = (typeof SEARCH_TOOL_NAMES)[number]
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
  query?: string
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

export interface SubagentActivityTimelineEntry extends ActivityTimelineBaseEntry {
  kind: "subagent"
  callId: string | null
  subagentId: SubagentId
  label: string
  // The focused task the manager delegated to this goblin (shown in the timeline
  // so the user can see what each goblin is researching).
  task?: string
  status: ToolInvocationStatus
}

export type ActivityTimelineEntry =
  | ToolActivityTimelineEntry
  | SearchActivityTimelineEntry
  | SourcesActivityTimelineEntry
  | ReasoningActivityTimelineEntry
  | SubagentActivityTimelineEntry

interface InteractionCheckpointFields {
  interactionId?: string
  lastEventId?: string
}

interface TextDeltaStreamEvent extends InteractionCheckpointFields {
  type: "text_delta"
  delta: string
}

interface ReasoningDeltaStreamEvent extends InteractionCheckpointFields {
  type: "reasoning_delta"
  delta: string
}

interface ToolCallStreamEvent extends InteractionCheckpointFields {
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

interface ToolResultStreamEvent extends InteractionCheckpointFields {
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

interface SourceStreamEvent extends InteractionCheckpointFields {
  type: "source"
  source: MessageSource
}

interface AgentStatusStreamEvent extends InteractionCheckpointFields {
  type: "agent_status"
  status: AgentRunStatus
}

interface SubagentCallStreamEvent extends InteractionCheckpointFields {
  type: "subagent_call"
  callId: string | null
  subagentId: SubagentId
  label: string
  task?: string
}

interface SubagentResultStreamEvent extends InteractionCheckpointFields {
  type: "subagent_result"
  callId: string | null
  subagentId: SubagentId
  status: Extract<ToolInvocationStatus, "success" | "error">
}

export type AgentStreamEvent =
  | TextDeltaStreamEvent
  | ReasoningDeltaStreamEvent
  | ToolCallStreamEvent
  | ToolResultStreamEvent
  | SourceStreamEvent
  | AgentStatusStreamEvent
  | SubagentCallStreamEvent
  | SubagentResultStreamEvent

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  llmModel: string
  createdAt: string
  metadata?: MessageMetadata
}

export type MessageAttachmentKind = "image" | "pdf"

export interface MessageAttachment {
  id: string
  kind: MessageAttachmentKind
  name: string
  mediaType: string
  /**
   * Base64 data URL of the file. Present in-session (so it can be previewed and
   * uploaded), omitted once the thread is persisted to keep stored threads lean.
   */
  url?: string
  /**
   * OpenAI Files API id, assigned server-side after the base64 is uploaded once.
   * Persisted and resent on later turns in place of the base64 `url` so the file
   * is uploaded a single time and its tokens stay prompt-cacheable across turns.
   */
  fileId?: string
}

interface MessageMetadata {
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
  attachments?: MessageAttachment[]
  followUpQuestions?: FollowUpQuestion[]
  followUpQuestionsPending?: boolean
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
