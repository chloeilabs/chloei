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

import { AnalysisForm } from "./analysis-form"
import { AnalyzingState } from "./analyzing-state"
import { DecisionBanner } from "./decision-banner"
import { ReportPanel } from "./report-panel"
import { useTradingDeskRun } from "./use-trading-desk-run"

function EmptyState() {
  return (
    <Empty className="min-h-[13rem] border-y border-dashed border-border/70 bg-transparent">
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
          <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
            <div className="flex flex-col gap-5">
              <AnalysisForm
                isRunning={isRunning}
                config={config}
                onRun={(request) => {
                  void startJob(request)
                }}
                onStop={stop}
              />

              {serviceError ? (
                <Alert>
                  <AlertTitle>TradingAgents unavailable</AlertTitle>
                  <AlertDescription>{serviceError}</AlertDescription>
                </Alert>
              ) : null}

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
                <div className="flex min-w-0 flex-col gap-4">
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
                  <ReportPanel
                    sections={state.sections}
                    debates={state.debates}
                  />
                </div>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Research output from automated agents. Not financial advice.
              </p>
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
