"use client"

import { CalendarIcon, Play, Square } from "lucide-react"
import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  TRADING_DESK_ANALYST_KEYS,
  TRADING_DESK_DEPTHS,
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

const TICKER_RE = /^[A-Za-z0-9.\-^=]{1,15}$/

function parseTradeDate(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) {
    return undefined
  }
  return new Date(year, month - 1, day)
}

function formatTradeDate(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatReadableDate(value: string): string {
  const date = parseTradeDate(value)
  if (!date) {
    return "mm/dd/yyyy"
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(date)
}

function isTradingDeskDepth(value: string): value is TradingDeskDepth {
  return (TRADING_DESK_DEPTHS as readonly string[]).includes(value)
}

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
  const [depth, setDepth] = useState<TradingDeskDepth>("shallow")
  const [dateOpen, setDateOpen] = useState(false)

  const tickerValid = TICKER_RE.test(ticker.trim())
  const canRun = tickerValid && !isRunning
  const depthIndex = TRADING_DESK_DEPTHS.indexOf(depth)

  function submit() {
    if (!canRun) {
      return
    }
    onRun({
      ticker: ticker.trim().toUpperCase(),
      tradeDate: tradeDate.trim() || null,
      analysts: [...TRADING_DESK_ANALYST_KEYS],
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
  const selectedDate = parseTradeDate(tradeDate)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="flex flex-col gap-4"
    >
      <FieldGroup className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(8rem,1fr)_11rem_10rem_auto]">
        <Field>
          <Input
            id="td-ticker"
            aria-label="Ticker"
            placeholder="TICKER"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={ticker}
            onChange={(event) => {
              setTicker(event.target.value.toUpperCase().slice(0, 15))
            }}
            className="font-departureMono tracking-tight uppercase"
          />
        </Field>
        <Field>
          <ToggleGroup
            value={[depth]}
            onValueChange={(values) => {
              const next = values[0]
              if (next && isTradingDeskDepth(next)) {
                setDepth(next)
              }
            }}
            spacing={0}
            aria-label="Research depth"
            className="relative grid h-10 w-full grid-cols-3 overflow-hidden border border-border bg-background p-1"
          >
            <div
              aria-hidden="true"
              className="absolute inset-y-1 left-1 bg-primary/20 shadow-[inset_0_0_0_1px_var(--primary)] transition-transform"
              style={{
                width: "calc((100% - 0.5rem) / 3)",
                transform: `translateX(${String(depthIndex * 100)}%)`,
              }}
            />
            {TRADING_DESK_DEPTHS.map((value, index) => {
              const active = depth === value
              return (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  aria-label={DEPTH_LABELS[value]}
                  className={cn(
                    "relative h-full min-w-0 bg-transparent px-1.5 font-departureMono text-[10px] transition-colors hover:bg-muted/55 aria-pressed:bg-transparent data-[state=on]:bg-transparent",
                    index > 0 &&
                      "before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span>{DEPTH_LABELS[value]}</span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </Field>
        <Field>
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button
                id="td-date"
                type="button"
                aria-label="As-of date"
                variant="outline"
                size="lg"
                className={cn(
                  "h-10 w-full min-w-[10rem] justify-between font-departureMono tracking-tight",
                  !tradeDate && "text-muted-foreground"
                )}
              >
                <span>{formatReadableDate(tradeDate)}</span>
                <CalendarIcon data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => {
                  if (!date) {
                    setTradeDate("")
                    return
                  }
                  setTradeDate(formatTradeDate(date))
                  setDateOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
        </Field>
        <div className="flex items-end">
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-10 w-full sm:w-auto"
              onClick={onStop}
            >
              <Square data-icon="inline-start" />
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="lg"
              className="h-10 w-full sm:w-auto"
              disabled={!canRun}
            >
              <Play data-icon="inline-start" />
              Run analysis
            </Button>
          )}
        </div>
      </FieldGroup>

      {serviceHint ? (
        <Alert>
          <AlertDescription>{serviceHint}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  )
}
