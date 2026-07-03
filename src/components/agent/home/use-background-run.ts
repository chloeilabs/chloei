import {
  type AgentStreamEvent,
  type BackgroundRunStatus,
  isBackgroundRunStatus,
} from "@/lib/shared"

import { parseStreamEventLine } from "./agent-stream-events"

const BACKGROUND_RUN_POLL_INTERVAL_MS = 2_500

export interface BackgroundRunStatusUpdate {
  status: BackgroundRunStatus
  terminal: boolean
  error?: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Follows a durable background Goblins run by polling its event log, feeding
 * validated events to the caller until the run reaches a terminal status (or
 * the signal aborts). Returns the terminal status, or null on abort. Poll
 * failures are retried on the next tick — the run advances server-side either
 * way.
 */
export async function followBackgroundRun(params: {
  runId: string
  startAfterEvent?: number
  signal?: AbortSignal
  onEvents: (events: AgentStreamEvent[]) => void
  onStatus?: (update: BackgroundRunStatusUpdate) => void
}): Promise<BackgroundRunStatus | null> {
  let afterEvent = params.startAfterEvent ?? 0

  for (;;) {
    if (params.signal?.aborted) {
      return null
    }

    try {
      const response = await fetch(
        `/api/agent/goblins-runs/${encodeURIComponent(params.runId)}?afterEvent=${String(afterEvent)}`,
        { signal: params.signal }
      )
      if (response.status === 401 || response.status === 404) {
        // The run is gone (or the session is) — stop following.
        return null
      }
      if (response.ok) {
        const payload = (await response.json()) as {
          status?: unknown
          terminal?: unknown
          events?: unknown
          error?: unknown
        }

        const rawEvents = Array.isArray(payload.events) ? payload.events : []
        afterEvent += rawEvents.length
        // Reuse the NDJSON line parser for validation so malformed log
        // entries degrade exactly like malformed stream lines.
        const events = rawEvents.flatMap((event) => {
          const parsed = parseStreamEventLine(JSON.stringify(event))
          return parsed ? [parsed] : []
        })
        if (events.length > 0) {
          params.onEvents(events)
        }

        if (isBackgroundRunStatus(payload.status)) {
          const terminal = payload.terminal === true
          params.onStatus?.({
            status: payload.status,
            terminal,
            ...(typeof payload.error === "string"
              ? { error: payload.error }
              : {}),
          })
          if (terminal) {
            return payload.status
          }
        }
      }
    } catch (error) {
      if (params.signal?.aborted) {
        return null
      }
      // Transient poll failure — retry on the next tick.
      void error
    }

    try {
      await sleep(BACKGROUND_RUN_POLL_INTERVAL_MS, params.signal)
    } catch {
      return null
    }
  }
}

/** Requests cancellation of a background run (idempotent server-side). */
export async function cancelBackgroundRun(runId: string): Promise<void> {
  try {
    await fetch(`/api/agent/goblins-runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    })
  } catch {
    // Best effort — the run's TTL eventually expires it anyway.
  }
}
