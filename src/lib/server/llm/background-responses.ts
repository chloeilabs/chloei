import type OpenAI from "openai"

import { type AgentStreamEvent } from "@/lib/shared"

interface CreateBackgroundResponseParams {
  model: string
  input: OpenAI.Responses.ResponseCreateParams["input"]
  instructions?: string
}

/**
 * Kicks off a long-running response in the background. It returns immediately
 * with the response id + status (`queued`/`in_progress`); the run continues
 * server-side and survives client disconnects. Stream it (or resume after a
 * drop) with `resumeBackgroundResponseStream`. `store: true` is required so the
 * response can be retrieved later.
 *
 * NOTE: this is the building block for disconnect-resilient runs. Wiring the
 * tool-using agent loop to *run in background* needs a worker (serverless
 * functions end with the response), so nothing in the app calls this yet.
 */
export async function createBackgroundResponse(
  client: OpenAI,
  params: CreateBackgroundResponseParams
): Promise<{ id: string; status: string }> {
  const response = await client.responses.create({
    model: params.model,
    input: params.input,
    ...(params.instructions ? { instructions: params.instructions } : {}),
    background: true,
    store: true,
    stream: false,
  })
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
    } else if (event.type === "response.completed") {
      yield { type: "agent_status", status: "completed", sequenceNumber }
    } else if (event.type === "response.failed") {
      yield { type: "agent_status", status: "failed", sequenceNumber }
    } else if (event.type === "response.incomplete") {
      yield { type: "agent_status", status: "incomplete", sequenceNumber }
    }
  }
}
