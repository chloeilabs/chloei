import { useEffect, useRef, useState } from "react"

/** Formats elapsed activity time as `12s`, `1m`, or `1m 5s`. */
export function formatActivityDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))

  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return seconds > 0
    ? `${String(minutes)}m ${String(seconds)}s`
    : `${String(minutes)}m`
}

/**
 * Tracks elapsed streaming time. Starts the clock on the first render where
 * `isStreaming` is true and freezes the last value once streaming stops.
 * Mirrors Onyx's `useStreamingDuration` (Date.now based, ~1s granularity).
 */
export function useActivityDuration(isStreaming: boolean): number | null {
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isStreaming) {
      return
    }

    startRef.current ??= Date.now()
    const intervalId = setInterval(() => {
      const startedAt = startRef.current
      if (startedAt != null) {
        setDurationMs(Date.now() - startedAt)
      }
    }, 500)

    return () => {
      clearInterval(intervalId)
    }
  }, [isStreaming])

  return durationMs
}
