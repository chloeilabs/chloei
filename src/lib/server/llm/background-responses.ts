import type OpenAI from "openai"

import { type AgentStreamEvent } from "@/lib/shared"

interface CreateBackgroundResponseParams {
  model: string
  input: OpenAI.Responses.ResponseCreateParams["input"]
  instructions?: string
  // Function/hosted tool definitions for the turn (goblins manager turns).
  tools?: OpenAI.Responses.Tool[]
  // Chains this turn onto a stored previous response (manager turn N-1).
  previousResponseId?: string
  metadata?: Record<string, string>
  reasoning?: OpenAI.Reasoning
  textVerbosity?: "low" | "medium" | "high"
  parallelToolCalls?: boolean
  promptCacheKey?: string
  promptCacheRetention?: "in_memory" | "24h"
  // Create the response with stream:true so clients may later live-tail it via
  // `resumeBackgroundResponseStream` (OpenAI only allows resuming streams on
  // responses created streaming). The creation stream itself is closed as soon
  // as the response id is known — the background run continues server-side.
  stream?: boolean
}

/**
 * Kicks off a long-running response in the background. It returns as soon as
 * the response id is known; the run continues server-side and survives client
 * disconnects. Stream it (or resume after a drop) with
 * `resumeBackgroundResponseStream`. `store: true` is required so the response
 * can be retrieved later. Used by the Goblins background continuation engine
 * for durable manager turns.
 */
export async function createBackgroundResponse(
  client: OpenAI,
  params: CreateBackgroundResponseParams
): Promise<{ id: string; status: string }> {
  const request = {
    model: params.model,
    input: params.input,
    ...(params.instructions ? { instructions: params.instructions } : {}),
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.previousResponseId
      ? { previous_response_id: params.previousResponseId }
      : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.textVerbosity
      ? { text: { verbosity: params.textVerbosity } }
      : {}),
    ...(params.parallelToolCalls !== undefined
      ? { parallel_tool_calls: params.parallelToolCalls }
      : {}),
    ...(params.promptCacheKey
      ? { prompt_cache_key: params.promptCacheKey }
      : {}),
    ...(params.promptCacheRetention
      ? { prompt_cache_retention: params.promptCacheRetention }
      : {}),
    background: true,
    store: true,
  }

  if (params.stream) {
    const stream = await client.responses.create({ ...request, stream: true })
    for await (const event of stream) {
      const response = (
        event as { response?: { id?: string; status?: string } }
      ).response
      if (response?.id) {
        // Detach from the creation stream; the background run keeps going.
        stream.controller.abort()
        return { id: response.id, status: response.status ?? "queued" }
      }
    }
    throw new Error("Background response stream ended without a response id.")
  }

  const response = await client.responses.create({ ...request, stream: false })
  return { id: response.id, status: response.status ?? "queued" }
}

// A mapped event plus the source sequence number, so a caller can persist the
// checkpoint and resume from `starting_after` on reconnect.
export type ResumableStreamEvent = AgentStreamEvent & {
  sequenceNumber?: number
}

/**
 * Streams a stored (background) response as AgentStreamEvents, resuming from
 * `startingAfter` (the last sequence number the client received) so a dropped
 * connection can reconnect without losing or repeating output.
 */
export async function* resumeBackgroundResponseStream(
  client: OpenAI,
  responseId: string,
  startingAfter?: number
): AsyncGenerator<ResumableStreamEvent> {
  const stream = await client.responses.retrieve(responseId, {
    stream: true,
    ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
  })

  for await (const event of stream) {
    const sequenceNumber =
      typeof event.sequence_number === "number"
        ? event.sequence_number
        : undefined

    if (event.type === "response.output_text.delta") {
      yield { type: "text_delta", delta: event.delta, sequenceNumber }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      yield { type: "reasoning_delta", delta: event.delta, sequenceNumber }
    } else if (event.type === "response.completed") {
      yield { type: "agent_status", status: "completed", sequenceNumber }
    } else if (event.type === "response.failed") {
      yield { type: "agent_status", status: "failed", sequenceNumber }
    } else if (event.type === "response.incomplete") {
      yield { type: "agent_status", status: "incomplete", sequenceNumber }
    }
  }
}
