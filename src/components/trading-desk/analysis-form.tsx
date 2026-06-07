"use client"

import { Play, Square } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  TRADING_DESK_ANALYST_KEYS,
  TRADING_DESK_ANALYST_LABELS,
  TRADING_DESK_DEPTHS,
  type TradingDeskAnalystKey,
  type TradingDeskConfig,
  type TradingDeskDepth,
  type TradingDeskRequest,
} from "@/lib/shared/trading-agents/types"
import { cn } from "@/lib/utils"

const DEPTH_LABELS: Record<TradingDeskDepth, string> = {
  shallow: "Shallow",
  medium: "Medium",
  deep: "Deep",
}
const DEPTH_HINTS: Record<TradingDeskDepth, string> = {
  shallow: "1 round · fastest",
  medium: "2 rounds · balanced",
  deep: "3 rounds · thorough",
}

const TICKER_RE = /^[A-Za-z0-9.\-^=]{1,15}$/

const microLabel =
  "font-departureMono text-[10px] tracking-wide text-muted-foreground uppercase"

export function AnalysisForm({
  isRunning,
  config,
  onRun,
  onStop,
}: {
  isRunning: boolean
  config: TradingDeskConfig | null
  onRun: (request: TradingDeskRequest) => void
  onStop: () => void
}) {
  const [ticker, setTicker] = useState("")
  const [tradeDate, setTradeDate] = useState("")
  const [analysts, setAnalysts] = useState<TradingDeskAnalystKey[]>([
    ...TRADING_DESK_ANALYST_KEYS,
  ])
  const [depth, setDepth] = useState<TradingDeskDepth>("shallow")

  const tickerValid = TICKER_RE.test(ticker.trim())
  const canRun = tickerValid && analysts.length > 0 && !isRunning

  function toggleAnalyst(key: TradingDeskAnalystKey) {
    setAnalysts((prev) =>
      prev.includes(key) ? prev.filter((a) => a !== key) : [...prev, key]
    )
  }

  function submit() {
    if (!canRun) {
      return
    }
    onRun({
      ticker: ticker.trim().toUpperCase(),
      tradeDate: tradeDate.trim() || null,
      analysts,
      depth,
      assetType: "stock",
      online: true,
      mock: null,
    })
  }

  const serviceHint = (() => {
    if (!config) {
      return null
    }
    if (config.mock_default) {
      return "Service is in mock mode — runs return canned analysis."
    }
    if (!config.llm_ready) {
      return "Service has no LLM key — set AI_GATEWAY_API_KEY in the sidecar to run live."
    }
    return null
  })()

  return (
    <div className="border border-border bg-card/40 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <label htmlFor="td-ticker" className={microLabel}>
              Ticker
            </label>
            <Input
              id="td-ticker"
              placeholder="NVDA"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={ticker}
              onChange={(event) => {
                setTicker(event.target.value.toUpperCase().slice(0, 15))
              }}
              className="font-departureMono tracking-tight uppercase"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="td-date" className={microLabel}>
              As-of date
            </label>
            <Input
              id="td-date"
              type="date"
              value={tradeDate}
              onChange={(event) => {
                setTradeDate(event.target.value)
              }}
              className="w-full sm:w-[10.5rem]"
            />
          </div>
        </div>

        <div className="space-y-2">
          <span className={microLabel}>Analysts</span>
          <div className="flex flex-wrap gap-2">
            {TRADING_DESK_ANALYST_KEYS.map((key) => {
              const active = analysts.includes(key)
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    toggleAnalyst(key)
                  }}
                  className={cn(
                    "cursor-pointer border px-3 py-1 text-sm transition-colors",
                    active
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {TRADING_DESK_ANALYST_LABELS[key]}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-2">
          <span className={microLabel}>Research depth</span>
          <div className="grid grid-cols-3 gap-2">
            {TRADING_DESK_DEPTHS.map((value) => {
              const active = depth === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setDepth(value)
                  }}
                  className={cn(
                    "cursor-pointer border px-2 py-2 text-left transition-colors",
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-border hover:bg-muted"
                  )}
                >
                  <div className="text-sm font-medium">
                    {DEPTH_LABELS[value]}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {DEPTH_HINTS[value]}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-end pt-1">
          {isRunning ? (
            <Button type="button" variant="outline" size="lg" onClick={onStop}>
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button type="submit" size="lg" disabled={!canRun}>
              <Play className="size-3.5" />
              Run analysis
            </Button>
          )}
        </div>

        {serviceHint ? (
          <p className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {serviceHint}
          </p>
        ) : null}
      </form>
    </div>
  )
}
