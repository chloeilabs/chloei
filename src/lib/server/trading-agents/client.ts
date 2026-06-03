/**
 * Server-side client for the TradingAgents sidecar service.
 *
 * Wraps the two upstream endpoints used by the Trading Desk:
 *  - `GET  /config`  → form/pipeline metadata
 *  - `POST /analyze` → SSE stream, transformed here into an NDJSON byte stream
 *    so the browser can read it with Chloei's existing line reader.
 */

import type {
  TaRunCompletedEvent,
  TradingDeskConfig,
  TradingDeskRequest,
} from "@/lib/shared/trading-agents/types"

import {
  TRADINGAGENTS_SERVICE_URL,
  tradingAgentsServiceHeaders,
} from "./config"

export class TradingAgentsServiceError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "TradingAgentsServiceError"
    this.status = status
  }
}

/** Fetch the service `/config` (roster, analysts, depth presets, defaults). */
export async function fetchTradingDeskConfig(
  signal?: AbortSignal
): Promise<TradingDeskConfig> {
  let response: Response
  try {
    response = await fetch(`${TRADINGAGENTS_SERVICE_URL}/config`, {
      method: "GET",
      headers: tradingAgentsServiceHeaders(),
      signal,
      cache: "no-store",
    })
  } catch (error) {
    throw new TradingAgentsServiceError(
      `TradingAgents service unreachable: ${(error as Error).message}`,
      503
    )
  }
  if (!response.ok) {
    throw new TradingAgentsServiceError(
      `TradingAgents service /config failed (${String(response.status)}).`,
      502
    )
  }
  return (await response.json()) as TradingDeskConfig
}

/** Map the camelCase client request to the service's snake_case body. */
function toServiceBody(request: TradingDeskRequest): Record<string, unknown> {
  return {
    ticker: request.ticker,
    trade_date: request.tradeDate ?? null,
    analysts: request.analysts,
    depth: request.depth,
    asset_type: request.assetType ?? "stock",
    online: request.online ?? true,
    mock: request.mock ?? null,
  }
}

/**
 * Start an analysis and return an NDJSON byte stream of events.
 *
 * The service speaks SSE (`data: {json}\n\n` frames). We transform to NDJSON
 * (`{json}\n` lines) so the client can reuse `readResponseStreamLines`.
 * The provided `signal` aborts the upstream request when the browser
 * disconnects.
 */
export async function streamTradingDeskAnalysis(
  request: TradingDeskRequest,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  let response: Response
  try {
    response = await fetch(`${TRADINGAGENTS_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: tradingAgentsServiceHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify(toServiceBody(request)),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new TradingAgentsServiceError("Client disconnected.", 499)
    }
    throw new TradingAgentsServiceError(
      `TradingAgents service unreachable: ${(error as Error).message}`,
      503
    )
  }

  if (!response.ok || !response.body) {
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 500)
    } catch {
      // ignore
    }
    throw new TradingAgentsServiceError(
      `TradingAgents service /analyze failed (${String(response.status)}). ${detail}`.trim(),
      502
    )
  }

  return response.body.pipeThrough(createSseToNdjsonTransform())
}

/**
 * Run an analysis to completion and return the final result.
 *
 * Consumes the NDJSON stream server-side and resolves with the
 * `run_completed` payload — used by the chat agent tool, which needs a single
 * aggregated result rather than a live stream. Throws on a service error event
 * or if the stream ends without completing.
 */
export async function fetchTradingDeskResult(
  request: TradingDeskRequest,
  signal?: AbortSignal
): Promise<TaRunCompletedEvent> {
  const effectiveSignal = signal ?? new AbortController().signal

  const ndjson = await streamTradingDeskAnalysis(request, effectiveSignal)
  const reader = ndjson.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let completed: TaRunCompletedEvent | null = null
  let errorMessage: string | null = null

  const parseLine = (line: string): { type?: unknown; message?: unknown } | null => {
    const trimmed = line.trim()
    if (!trimmed) {
      return null
    }
    try {
      return JSON.parse(trimmed) as { type?: unknown; message?: unknown }
    } catch {
      return null
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event = parseLine(line)
      if (!event) {
        continue
      }
      if (event.type === "run_completed") {
        completed = event as TaRunCompletedEvent
      } else if (event.type === "error") {
        errorMessage =
          typeof event.message === "string" ? event.message : "Analysis failed."
      }
    }
  }
  const tail = parseLine(buffer)
  if (tail?.type === "run_completed") {
    completed = tail as TaRunCompletedEvent
  } else if (tail?.type === "error") {
    errorMessage =
      typeof tail.message === "string" ? tail.message : "Analysis failed."
  }

  if (completed !== null) {
    return completed
  }
  throw new TradingAgentsServiceError(
    errorMessage ?? "The analysis did not complete.",
    502
  )
}

/**
 * Transform an SSE byte stream into an NDJSON byte stream.
 *
 * Each SSE event is a block separated by a blank line; `data:` lines within a
 * block carry the payload (concatenated with newlines per the SSE spec). We
 * emit each event's data payload as a single NDJSON line.
 */
function createSseToNdjsonTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  function emitBlock(
    block: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    const dataLines: string[] = []
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "")
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""))
      }
    }
    if (dataLines.length === 0) {
      return
    }
    const payload = dataLines.join("\n").trim()
    if (payload) {
      controller.enqueue(encoder.encode(`${payload}\n`))
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      // SSE event boundary is a blank line. Normalise CRLF first.
      const normalized = buffer.replace(/\r\n/g, "\n")
      const blocks = normalized.split("\n\n")
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        emitBlock(block, controller)
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      const normalized = buffer.replace(/\r\n/g, "\n")
      for (const block of normalized.split("\n\n")) {
        emitBlock(block, controller)
      }
    },
  })
}
