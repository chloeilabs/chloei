"use client"

import { CandlestickChart } from "lucide-react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { useThreadStore } from "@/components/agent/home/use-thread-store"
import { AppSidebar } from "@/components/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import type { AuthViewer } from "@/lib/shared/auth"
import type { TradingDeskConfig } from "@/lib/shared/trading-agents/types"

import { AgentPipeline } from "./agent-pipeline"
import { AnalysisForm } from "./analysis-form"
import { AnalyzingState } from "./analyzing-state"
import { DecisionBanner } from "./decision-banner"
import { ReportPanel } from "./report-panel"
import { useTradingDeskRun } from "./use-trading-desk-run"

const AppLauncher = dynamic(
  () =>
    import("@/components/agent/home/app-launcher").then(
      (mod) => mod.AppLauncher
    ),
  {
    ssr: false,
    loading: () => <div className="size-7" />,
  }
)

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
    <div className="border border-dashed border-border p-8 text-center">
      <CandlestickChart className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-medium">Run a multi-agent analysis</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Enter a ticker and run the desk. A team of specialized agents —
        analysts, researchers, a trader, and a risk committee — debate the setup
        and return a Buy / Hold / Sell decision.
      </p>
    </div>
  )
}

export function TradingDesk({ viewer }: { viewer: AuthViewer }) {
  const router = useRouter()
  const threadStore = useThreadStore()
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
            <AppLauncher className="size-7 text-muted-foreground hover:text-foreground" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_1fr]">
              {/* Controls */}
              <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
                <AnalysisForm
                  isRunning={isRunning}
                  config={config}
                  onRun={(request) => {
                    void startJob(request)
                  }}
                  onStop={stop}
                />
                {serviceError ? (
                  <p className="border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {serviceError}
                  </p>
                ) : null}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Research output from automated agents. Not financial advice.
                </p>
              </div>

              {/* Output */}
              <div className="min-w-0 space-y-4">
                {!state ? (
                  <EmptyState />
                ) : state.status === "running" ? (
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
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
