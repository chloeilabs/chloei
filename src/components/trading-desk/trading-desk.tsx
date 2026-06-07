"use client"

import { CandlestickChart } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { useThreadStoreContext } from "@/components/agent/home/thread-store-context"
import { AppSidebar } from "@/components/app-sidebar"
import { TradingDeskNavButton } from "@/components/trading-desk-nav-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import type { AuthViewer } from "@/lib/shared/auth"
import type { TradingDeskConfig } from "@/lib/shared/trading-agents/types"
import { cn } from "@/lib/utils"

import { AgentPipeline } from "./agent-pipeline"
import { AnalysisForm } from "./analysis-form"
import { AnalyzingState } from "./analyzing-state"
import { DecisionBanner } from "./decision-banner"
import { ReportPanel } from "./report-panel"
import { useTradingDeskRun } from "./use-trading-desk-run"

function StatsFooter({
  stats,
}: {
  stats: {
    llm_calls: number
    tool_calls: number
    tokens_in: number
    tokens_out: number
    elapsed_seconds?: number
  } | null
}) {
  if (!stats) {
    return null
  }
  const items: [string, string][] = [
    ["LLM calls", String(stats.llm_calls)],
    ["Tool calls", String(stats.tool_calls)],
    ["Tokens in", stats.tokens_in.toLocaleString()],
    ["Tokens out", stats.tokens_out.toLocaleString()],
  ]
  if (typeof stats.elapsed_seconds === "number") {
    items.push(["Elapsed", `${stats.elapsed_seconds.toFixed(1)}s`])
  }
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 border border-border bg-card/40 px-3 py-2.5">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="font-departureMono text-[10px] tracking-wide text-muted-foreground uppercase">
            {label}
          </dt>
          <dd className="text-xs text-foreground/80">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function EmptyState() {
  return (
    <Empty className="min-h-[13rem] border border-dashed border-border bg-card/30">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CandlestickChart />
        </EmptyMedia>
        <EmptyTitle>Run a multi-agent analysis</EmptyTitle>
        <EmptyDescription className="max-w-lg">
          Enter a ticker and run the desk. A team of specialized agents —
          analysts, researchers, a trader, and a risk committee — debate the
          setup and return a Buy / Hold / Sell decision.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function TradingDesk({ viewer }: { viewer: AuthViewer }) {
  const router = useRouter()
  const threadStore = useThreadStoreContext()
  const { state, startJob, stop, isRunning } = useTradingDeskRun()
  const [config, setConfig] = useState<TradingDeskConfig | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch("/api/trading-desk/config", {
          cache: "no-store",
          signal: controller.signal,
        })
        if (!response.ok) {
          setServiceError(
            "TradingAgents service is not reachable. Start it (see tradingagents-service/) or set TRADINGAGENTS_SERVICE_URL."
          )
          return
        }
        const data = (await response.json()) as TradingDeskConfig
        setConfig(data)
        setServiceError(null)
      } catch {
        if (controller.signal.aborted) {
          return
        }
        setServiceError("TradingAgents service is not reachable.")
      }
    })()
    return () => {
      controller.abort()
    }
  }, [])

  const decision = state?.decision ?? ""
  const judgeCall = state?.debates.risk.judge ?? ""
  const decisionText = decision.length > 0 ? decision : judgeCall
  const isIdle = !state

  return (
    <SidebarProvider className="min-h-0 flex-1">
      <AppSidebar
        viewer={viewer}
        threadSummaries={threadStore.threadSummaries}
        isThreadSummariesLoading={threadStore.isLoadingThreadSummaries}
        currentThreadId={null}
        onSelectThread={() => {
          router.push("/")
        }}
        onDeleteThread={threadStore.deleteThread}
        onNewChat={() => {
          router.push("/")
        }}
      />
      <SidebarInset className="relative flex min-h-0 w-full flex-col overflow-hidden">
        <div className="z-10 flex shrink-0 items-center justify-between bg-background p-3">
          <div className="flex min-w-0 items-center justify-start gap-1">
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          </div>
          <div className="flex items-center gap-1">
            <TradingDeskNavButton />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto w-full px-4 py-5 sm:px-6",
              isIdle ? "max-w-4xl" : "max-w-6xl"
            )}
          >
            <div
              className={cn(
                "grid grid-cols-1 gap-5",
                !isIdle && "lg:grid-cols-[36rem_minmax(0,1fr)]"
              )}
            >
              {/* Controls */}
              <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
                <AnalysisForm
                  isRunning={isRunning}
                  config={config}
                  onRun={(request) => {
                    void startJob(request)
                  }}
                  onStop={stop}
                />
                {!state ? <EmptyState /> : null}
                {serviceError ? (
                  <Alert>
                    <AlertTitle>TradingAgents unavailable</AlertTitle>
                    <AlertDescription>{serviceError}</AlertDescription>
                  </Alert>
                ) : null}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Research output from automated agents. Not financial advice.
                </p>
              </div>

              {state ? (
                <div className="flex min-w-0 flex-col gap-4">
                  {state.status === "running" ? (
                    <AnalyzingState
                      ticker={state.ticker}
                      startedAt={state.startedAt}
                      agentCount={Object.keys(state.agentStatus).length}
                      mock={state.mock}
                    />
                  ) : (
                    <>
                      <DecisionBanner
                        ticker={state.ticker}
                        tradeDate={state.tradeDate}
                        signal={state.signal}
                        status={state.status}
                        mock={state.mock}
                        decisionText={decisionText}
                      />
                      {state.error ? (
                        <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                          {state.error}
                        </p>
                      ) : null}
                      <StatsFooter stats={state.stats} />
                      <AgentPipeline
                        teams={state.teams}
                        agentStatus={state.agentStatus}
                      />
                      <ReportPanel
                        sections={state.sections}
                        debates={state.debates}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
