import { asRecord, asString } from "@/lib/cast"
import { type AgentStreamEvent, type SubagentId } from "@/lib/shared"

import { createReasoningDisplaySanitizer } from "./initial-reasoning-chunk-sanitizer"
import {
  getExaToolCallMetadata,
  getExaToolResultMetadata,
  isExaToolName,
} from "./openai-agents-exa-tools"

// Pure readers for the Agents SDK's NORMALIZED raw-model events. Assistant text
// arrives as { type: "output_text_delta", delta }. Reasoning summaries have no
// normalized event and come via the raw passthrough { type: "model", event:
// <OpenAI Responses event> } as response.reasoning_summary_text.delta.
export function readTextDelta(eventData: unknown): string | null {
  const data = asRecord(eventData)
  if (asString(data?.type) === "output_text_delta") {
    return asString(data?.delta) ?? ""
  }
  return null
}

export function readReasoningDelta(eventData: unknown): string | null {
  const data = asRecord(eventData)
  if (asString(data?.type) !== "model") {
    return null
  }
  const raw = asRecord(data?.event)
  const rawType = asString(raw?.type)
  if (
    rawType === "response.reasoning_summary_text.delta" ||
    rawType === "response.reasoning_text.delta"
  ) {
    return asString(raw?.delta) ?? ""
  }
  return null
}

export function shouldSkipReasoningChunk(text: string): boolean {
  return text.trim() === "[REDACTED]"
}

// Some raw OpenAI Responses events (reasoning summaries, url_citation
// annotations) arrive through the SDK's { type: "model", event: <raw> }
// passthrough channel. This reads that nested raw event.
interface ModelPassthroughEvent {
  type: string
  itemId?: string
  annotation?: Record<string, unknown>
}

function readModelPassthroughEvent(
  eventData: unknown
): ModelPassthroughEvent | null {
  const data = asRecord(eventData)
  if (asString(data?.type) !== "model") {
    return null
  }
  const raw = asRecord(data?.event)
  const type = asString(raw?.type)
  if (!type) {
    return null
  }
  return {
    type,
    itemId: asString(raw?.item_id) ?? asString(raw?.id) ?? undefined,
    annotation: asRecord(raw?.annotation) ?? undefined,
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value
}

function normalizeToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

export interface SubagentToolInfo {
  subagentId: SubagentId
  label: string
}

// Degraded-brief marker returned by a failed goblin's tool execute (adaptive
// mode). Defined here — not in goblins-agents — so the mapper can detect it
// without an import cycle; goblins-agents re-exports it.
export const GOBLIN_ERROR_PREFIX = "GOBLIN_ERROR:"

export interface AgentStreamMapperOptions {
  // When provided, run-item tool events whose tool name resolves to a sub-agent
  // are surfaced as subagent_call / subagent_result events instead of the
  // Exa-tool tool_call / tool_result events. Used by Goblins mode.
  resolveSubagent?: (toolName: string) => SubagentToolInfo | null
}

type SourceStreamEvent = Extract<AgentStreamEvent, { type: "source" }>

export interface AgentStreamMapper {
  mapRawModelEvent(eventData: unknown): AgentStreamEvent[]
  mapRunItemEvent(eventName: string, item: unknown): AgentStreamEvent[]
  flushReasoning(): AgentStreamEvent[]
}

/**
 * Builds a stateful mapper that converts Agents SDK stream events into the
 * NDJSON AgentStreamEvent contract. Extracted from the single-model runtime so
 * the Goblins (multi-agent) runtime reuses identical source-dedup and reasoning
 * sanitization. One mapper instance per request/run.
 */
export function createAgentStreamMapper(
  options: AgentStreamMapperOptions = {}
): AgentStreamMapper {
  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()
  const toolNamesByCallId = new Map<string, string>()
  const seenSubagentCalls = new Set<string>()
  const finalizedSubagentCalls = new Set<string>()
  const sanitizeReasoningChunk = createReasoningDisplaySanitizer()

  const createSourceEvent = (
    id: string,
    url: string,
    title: string
  ): SourceStreamEvent | null => {
    const normalizedUrl = url.trim()
    const normalizedTitle = title.trim() || normalizedUrl
    if (!normalizedUrl || seenSourceKeys.has(normalizedUrl)) {
      return null
    }

    seenSourceKeys.add(normalizedUrl)
    return {
      type: "source",
      source: { id, url: normalizedUrl, title: normalizedTitle },
    }
  }

  // Hosted OpenAI tool items ("web_search_call" etc.). Emits the tool_call on
  // first sight and the balancing tool_result once the item reports a terminal
  // status — hosted outputs arrive whole, and an unbalanced call would trip the
  // route's unresolved-tool-call fallback.
  const mapHostedToolItem = (
    rawItem: Record<string, unknown> | null
  ): AgentStreamEvent[] => {
    const events: AgentStreamEvent[] = []
    const hostedName = asString(rawItem?.name)?.replace(/_call$/, "")
    if (
      hostedName !== "web_search" &&
      hostedName !== "file_search" &&
      hostedName !== "code_interpreter"
    ) {
      return events
    }

    const callId = asString(rawItem?.id) ?? crypto.randomUUID()
    const status = asString(rawItem?.status)

    if (!seenToolCalls.has(callId)) {
      seenToolCalls.add(callId)
      const args = asRecord(parseToolArguments(rawItem?.arguments))
      const query =
        asString(args?.query)?.trim() ??
        asString(asRecord(args?.action)?.query)?.trim()
      const label =
        hostedName === "web_search"
          ? "Searching the web"
          : hostedName === "file_search"
            ? "Searching your documents"
            : "Running calculations"
      events.push({
        type: "tool_call",
        callId,
        toolName: hostedName,
        label,
        ...(query ? { query } : {}),
        operation: hostedName,
        provider: "openai",
      })
    }

    const isTerminal = status === "completed" || status === "failed"
    if (isTerminal && !finalizedToolCalls.has(callId)) {
      finalizedToolCalls.add(callId)
      events.push({
        type: "tool_result",
        callId,
        toolName: hostedName,
        status: status === "failed" ? "error" : "success",
        operation: hostedName,
        provider: "openai",
        ...(status === "failed" ? { errorCode: "HOSTED_TOOL_FAILED" } : {}),
      })
    }

    return events
  }

  const mapExaToolOutput = (
    callId: string,
    toolName: string,
    output: unknown
  ): AgentStreamEvent[] => {
    const events: AgentStreamEvent[] = []
    if (finalizedToolCalls.has(callId)) {
      return events
    }

    const normalizedOutput = normalizeToolOutput(output)

    // The SDK returns a plain string (not our {output|error} payload) when the
    // model sent invalid tool-call arguments and execute never ran
    // (InvalidToolInputError). Surface it as a clean, retryable error.
    if (!asRecord(normalizedOutput)) {
      finalizedToolCalls.add(callId)
      events.push({
        type: "tool_result",
        callId,
        toolName: toolName === "exa_search" ? "exa_search" : "exa_get_contents",
        status: "error",
        operation: toolName === "exa_search" ? "search" : "get_contents",
        provider: "exa",
        errorCode: "TOOL_INPUT_ERROR",
        retryable: true,
      })
      return events
    }

    const metadata = getExaToolResultMetadata({
      toolCallId: callId,
      toolName,
      output: normalizedOutput,
    })
    if (!metadata) {
      return events
    }

    finalizedToolCalls.add(metadata.callId)
    events.push({
      type: "tool_result",
      callId: metadata.callId,
      toolName: metadata.toolName,
      status: metadata.status,
      ...(metadata.operation ? { operation: metadata.operation } : {}),
      ...(metadata.provider ? { provider: metadata.provider } : {}),
      ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
      ...(metadata.retryable !== undefined
        ? { retryable: metadata.retryable }
        : {}),
    })

    for (const source of metadata.sources) {
      const sourceEvent = createSourceEvent(source.id, source.url, source.title)
      if (sourceEvent) {
        events.push(sourceEvent)
      }
    }

    return events
  }

  return {
    mapRawModelEvent(eventData) {
      const events: AgentStreamEvent[] = []

      const reasoningDelta = readReasoningDelta(eventData)
      if (reasoningDelta !== null) {
        const delta = sanitizeReasoningChunk(reasoningDelta)
        if (delta.length > 0 && !shouldSkipReasoningChunk(delta)) {
          events.push({ type: "reasoning_delta", delta })
        }
        return events
      }

      // Inline url_citation annotations (if any) surface as sources, deduped
      // against Exa sources.
      const passthrough = readModelPassthroughEvent(eventData)
      if (passthrough) {
        if (passthrough.type === "response.output_text.annotation.added") {
          const annotation = passthrough.annotation
          if (asString(annotation?.type) === "url_citation") {
            const url = asString(annotation?.url)
            if (url) {
              const title = asString(annotation?.title) ?? url
              const sourceEvent = createSourceEvent(url, url, title)
              if (sourceEvent) {
                events.push(sourceEvent)
              }
            }
          }
          return events
        }
      }

      const textDelta = readTextDelta(eventData)
      if (textDelta && textDelta.length > 0) {
        events.push({ type: "text_delta", delta: textDelta })
      }
      return events
    },

    mapRunItemEvent(eventName, item) {
      const events: AgentStreamEvent[] = []
      const itemRecord = asRecord(item)
      const rawItem = asRecord(itemRecord?.rawItem)

      // Hosted OpenAI tools (web_search / file_search / code_interpreter)
      // arrive as hosted_tool_call items with an `id` (no callId) and carry
      // their status/output on the item itself, so one item may need to emit
      // both the call and its balancing result.
      if (
        (eventName === "tool_called" || eventName === "tool_output") &&
        asString(rawItem?.type) === "hosted_tool_call"
      ) {
        return mapHostedToolItem(rawItem)
      }

      if (eventName === "tool_called") {
        const callId = asString(rawItem?.callId)
        const toolName = asString(rawItem?.name)
        if (!callId || !toolName) {
          return events
        }
        toolNamesByCallId.set(callId, toolName)

        const subagent = options.resolveSubagent?.(toolName)
        if (subagent) {
          if (!seenSubagentCalls.has(callId)) {
            seenSubagentCalls.add(callId)
            const args = asRecord(parseToolArguments(rawItem?.arguments))
            const task = asString(args?.input)?.trim()
            events.push({
              type: "subagent_call",
              callId,
              subagentId: subagent.subagentId,
              label: subagent.label,
              ...(task ? { task } : {}),
            })
          }
          return events
        }

        const metadata = getExaToolCallMetadata({
          toolCallId: callId,
          toolName,
          input: parseToolArguments(rawItem?.arguments),
        })
        if (!metadata || seenToolCalls.has(metadata.callId)) {
          return events
        }

        seenToolCalls.add(metadata.callId)
        events.push({
          type: "tool_call",
          callId: metadata.callId,
          toolName: metadata.toolName,
          label: metadata.label,
          ...(metadata.query ? { query: metadata.query } : {}),
          ...(metadata.operation ? { operation: metadata.operation } : {}),
          ...(metadata.provider ? { provider: metadata.provider } : {}),
        })
        return events
      }

      if (eventName === "tool_output") {
        const callId = asString(rawItem?.callId)
        const toolName =
          asString(rawItem?.name) ??
          (callId ? toolNamesByCallId.get(callId) : undefined)
        if (!callId || !toolName) {
          return events
        }

        const subagent = options.resolveSubagent?.(toolName)
        if (subagent) {
          if (!finalizedSubagentCalls.has(callId)) {
            finalizedSubagentCalls.add(callId)
            // A degraded brief (GOBLIN_ERROR prefix) marks the goblin failed;
            // the manager still receives the brief text and adapts per its
            // orchestration instruction.
            const outputText = asString(itemRecord?.output)?.trim()
            const failed = outputText?.startsWith(GOBLIN_ERROR_PREFIX) ?? false
            events.push({
              type: "subagent_result",
              callId,
              subagentId: subagent.subagentId,
              status: failed ? "error" : "success",
              ...(failed ? { errorCode: "GOBLIN_FAILED" } : {}),
            })
          }
          return events
        }

        if (!isExaToolName(toolName)) {
          return events
        }

        return mapExaToolOutput(callId, toolName, itemRecord?.output)
      }

      return events
    },

    flushReasoning() {
      const finalReasoningDelta = sanitizeReasoningChunk.flush()
      if (
        finalReasoningDelta.length > 0 &&
        !shouldSkipReasoningChunk(finalReasoningDelta)
      ) {
        return [{ type: "reasoning_delta", delta: finalReasoningDelta }]
      }
      return []
    },
  }
}
