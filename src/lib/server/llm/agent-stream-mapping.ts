import { asRecord, asString } from "@/lib/cast"
import { type AgentStreamEvent } from "@/lib/shared"

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

type SourceStreamEvent = Extract<AgentStreamEvent, { type: "source" }>

export interface AgentStreamMapper {
  mapRawModelEvent(eventData: unknown): AgentStreamEvent[]
  mapRunItemEvent(eventName: string, item: unknown): AgentStreamEvent[]
  flushReasoning(): AgentStreamEvent[]
}

/**
 * Builds a stateful mapper that converts Agents SDK stream events into the
 * NDJSON AgentStreamEvent contract. One mapper instance per request/run.
 */
export function createAgentStreamMapper(): AgentStreamMapper {
  const seenToolCalls = new Set<string>()
  const finalizedToolCalls = new Set<string>()
  const seenSourceKeys = new Set<string>()
  const toolNamesByCallId = new Map<string, string>()
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

      if (eventName === "tool_called") {
        const callId = asString(rawItem?.callId)
        const toolName = asString(rawItem?.name)
        if (!callId || !toolName) {
          return events
        }
        toolNamesByCallId.set(callId, toolName)

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
