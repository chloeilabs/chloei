import { useEffect, useState } from "react"

const DEFAULT_PACING_MS = 200

/**
 * Reveals list items in a staged fashion — one more every `stepMs` — while
 * `active` is true, so steps cascade in instead of all appearing at once.
 * Mirrors Onyx's `usePacedTurnGroups` (200ms pacing). When inactive (streaming
 * finished), every item is revealed immediately.
 *
 * Returns the number of items that should currently be visible.
 */
export function usePacedReveal(
  total: number,
  { active, stepMs = DEFAULT_PACING_MS }: { active: boolean; stepMs?: number }
): number {
  const [revealed, setRevealed] = useState(active ? 0 : total)

  useEffect(() => {
    if (!active || revealed >= total) {
      return
    }

    const timeoutId = setTimeout(() => {
      setRevealed((current) => Math.min(current + 1, total))
    }, stepMs)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [active, total, revealed, stepMs])

  // When inactive, reveal everything immediately without writing state from the
  // effect (avoids cascading renders); the ramp only runs while active.
  return active ? Math.min(revealed, total) : total
}
