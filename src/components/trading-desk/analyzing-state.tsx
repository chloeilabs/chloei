"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`
}

/** Shown while a background run is in flight — a ticking elapsed timer plus
 *  context, since background mode reveals no per-agent progress until done. */
export function AnalyzingState({
  ticker,
  startedAt,
  agentCount,
  mock,
}: {
  ticker: string | null
  startedAt: number
  agentCount: number
  mock: boolean
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(id)
    }
  }, [])

  return (
    <div className="flex flex-col items-center border-y border-border/70 py-12 text-center">
      <Loader2 className="size-6 animate-spin text-primary" />
      <div className="mt-4 flex items-center gap-2">
        <span className="font-departureMono text-sm tracking-tight text-muted-foreground">
          Analyzing
        </span>
        <span className="font-departureMono text-sm font-medium tracking-tight">
          {ticker ?? "—"}
        </span>
        {mock ? (
          <span className="font-departureMono text-[10px] tracking-wide text-muted-foreground uppercase">
            Mock
          </span>
        ) : null}
      </div>
      <div className="mt-2 font-departureMono text-4xl font-medium tracking-tight text-primary tabular-nums">
        {formatElapsed(now - startedAt)}
      </div>
      <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Running {agentCount} agents through the desk — analysts, a bull-vs-bear
        debate, a trader, and a risk committee. A full run usually takes 1–3
        minutes.
      </p>
    </div>
  )
}
