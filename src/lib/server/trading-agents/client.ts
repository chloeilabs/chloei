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
  TRADINGAGENTS_REQUEST_TIMEOUT_MS,
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

/**
 * Combine an optional caller signal with a request-timeout deadline so a stuck
 * sidecar can never hang the call indefinitely. Without a caller signal the
 * timeout alone bounds the request.
 */
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TRADINGAGENTS_REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
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
      signal: requestSignal(signal),
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
 * Signals that the `/analyze` stream dropped before emitting any event — the
 * one failure that is safe to retry (no analysis work has streamed yet).
 */
class EarlyAnalysisDropError extends Error {
  readonly reason: unknown

  constructor(reason: unknown) {
    super("The analysis stream ended before any event was received.")
    this.name = "EarlyAnalysisDropError"
    this.reason = reason
  }
}

/**
 * Consume one `/analyze` attempt and resolve with the `run_completed` payload.
 * Throws `EarlyAnalysisDropError` if the connection drops before any event
 * arrives; rethrows the underlying error on a mid-stream drop.
 */
async function consumeTradingDeskStream(
  request: TradingDeskRequest,
  signal: AbortSignal
): Promise<TaRunCompletedEvent> {
  const ndjson = await streamTradingDeskAnalysis(request, signal)
  const reader = ndjson.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let completed: TaRunCompletedEvent | null = null
  let errorMessage: string | null = null
  let receivedEvent = false

  const parseLine = (
    line: string
  ): { type?: unknown; message?: unknown } | null => {
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

  try {
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
        // Count only a parsed event as progress — a bare keepalive/partial
        // chunk must not disable the early-drop retry below.
        receivedEvent = true
        if (event.type === "run_completed") {
          completed = event as TaRunCompletedEvent
        } else if (event.type === "error") {
          errorMessage =
            typeof event.message === "string"
              ? event.message
              : "Analysis failed."
        }
      }
    }
  } catch (error) {
    // A drop before any event streamed is safe to retry; a mid-stream drop is
    // not (work has happened and re-running a deep analysis is expensive).
    if (!receivedEvent && !signal.aborted) {
      throw new EarlyAnalysisDropError(error)
    }
    throw error
  }

  const tail = parseLine(buffer)
  if (tail) {
    receivedEvent = true
    if (tail.type === "run_completed") {
      completed = tail as TaRunCompletedEvent
    } else if (tail.type === "error") {
      errorMessage =
        typeof tail.message === "string" ? tail.message : "Analysis failed."
    }
  }

  if (completed !== null) {
    return completed
  }
  // A stream that ended without ever producing an event (even a clean close) is
  // an early drop — safe to retry. Only treat it as a hard failure once at
  // least one event has streamed.
  if (!receivedEvent && !signal.aborted) {
    throw new EarlyAnalysisDropError(
      new TradingAgentsServiceError(
        errorMessage ?? "The analysis stream ended before any event.",
        502
      )
    )
  }
  throw new TradingAgentsServiceError(
    errorMessage ?? "The analysis did not complete.",
    502
  )
}

/**
 * Run an analysis to completion and return the final result.
 *
 * Consumes the NDJSON stream server-side and resolves with the
 * `run_completed` payload — used by the chat agent tool, which needs a single
 * aggregated result rather than a live stream. Throws on a service error event
 * or if the stream ends without completing.
 *
 * Retries once if the sidecar drops the connection before its first event
 * (e.g. a cold spin-up): no analysis has streamed at that point, so the retry
 * is safe and cheap. A mid-stream failure is surfaced immediately.
 */
export async function fetchTradingDeskResult(
  request: TradingDeskRequest,
  signal?: AbortSignal
): Promise<TaRunCompletedEvent> {
  // Bound the run with a timeout (combined with the caller signal if any) so a
  // stalled deep run can't stream/hang forever with no cancellation path.
  const effectiveSignal = requestSignal(signal)

  let lastReason: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await consumeTradingDeskStream(request, effectiveSignal)
    } catch (error) {
      if (!(error instanceof EarlyAnalysisDropError)) {
        throw error
      }
      lastReason = error.reason
      // First early drop: loop to retry. Second: fall through and surface it.
    }
  }

  const detail = lastReason instanceof Error ? `: ${lastReason.message}` : ""
  throw new TradingAgentsServiceError(
    `TradingAgents service /analyze stream terminated before any event${detail}`.trim(),
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
