"use client"

import {
  Loader2,
  Minus,
  OctagonX,
  TrendingDown,
  TrendingUp,
} from "lucide-react"

import { tradingDeskSignalTone } from "@/lib/shared/trading-agents/types"
import { cn } from "@/lib/utils"

import { ReportMarkdown } from "./report-markdown"
import type { TradingDeskRunStatus } from "./use-trading-desk-run"

// On-palette tones: vesper-teal (bullish), destructive (bearish), muted (neutral).
const TONE = {
  bullish: {
    text: "text-vesper-teal",
    Icon: TrendingUp,
  },
  bearish: {
    text: "text-destructive",
    Icon: TrendingDown,
  },
  neutral: {
    text: "text-foreground",
    Icon: Minus,
  },
} as const

export function DecisionBanner({
  ticker,
  tradeDate,
  signal,
  status,
  mock,
  decisionText,
}: {
  ticker: string | null
  tradeDate: string | null
  signal: string | null
  status: TradingDeskRunStatus
  mock: boolean
  decisionText: string
}) {
  const tone = signal ? tradingDeskSignalTone(signal) : "neutral"
  const palette = TONE[tone]
  const isError = status === "error"
  const isStopped = status === "stopped"
  const isRunningHeadline = status === "running" && !signal

  const Icon = isError ? OctagonX : isRunningHeadline ? Loader2 : palette.Icon

  const headline = isError
    ? "Analysis failed"
    : isStopped && !signal
      ? "Analysis stopped"
      : signal
        ? signal.toUpperCase()
        : "Analyzing"

  const accentText = isError
    ? "text-destructive"
    : isRunningHeadline
      ? "text-primary"
      : palette.text

  return (
    <div role="status" aria-live="polite" className="py-4 sm:py-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-departureMono text-base font-medium tracking-tight">
            {ticker ?? "—"}
          </span>
          {tradeDate ? (
            <span className="text-xs text-muted-foreground">
              as of {tradeDate}
            </span>
          ) : null}
          {mock ? (
            <span className="font-departureMono text-[10px] tracking-wide text-muted-foreground uppercase">
              Mock
            </span>
          ) : null}
        </div>

        <div
          className={cn(
            "mt-1 flex items-center gap-2 font-departureMono text-2xl font-medium tracking-tight",
            accentText
          )}
        >
          <span>{headline}</span>
          <Icon className={cn("size-5", isRunningHeadline && "animate-spin")} />
        </div>

        {decisionText ? (
          <div className="mt-2 text-sm text-foreground/80">
            <ReportMarkdown
              content={decisionText}
              id="trading-desk-decision"
              showSourceFavicon={false}
            />
          </div>
        ) : isRunningHeadline ? (
          <p className="mt-2 text-sm text-muted-foreground">
            The desk is working through the analyst, research, trading, and risk
            teams. The final call will appear here.
          </p>
        ) : null}
      </div>
    </div>
  )
}
