"use client"

import { useCallback, useRef, useState } from "react"

import { readResponseStreamLines } from "@/components/agent/home/agent-stream-events"
import {
  parseTradingDeskEventLine,
  TRADING_DESK_DEFAULT_TEAMS,
  type TradingDeskAgentStatus,
  type TradingDeskDebates,
  type TradingDeskEvent,
  type TradingDeskRequest,
  type TradingDeskStats,
  type TradingDeskTeam,
} from "@/lib/shared/trading-agents/types"

export type TradingDeskRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "stopped"

export interface TradingDeskSectionState {
  key: string
  title: string
  team: string
  content: string
  order: number
}

export interface TradingDeskActivityItem {
  id: number
  kind: string
  agent: string | null
  text: string
}

export interface TradingDeskRunState {
  status: TradingDeskRunStatus
  ticker: string | null
  tradeDate: string | null
  teams: TradingDeskTeam[]
  agentStatus: Record<string, TradingDeskAgentStatus>
  sections: Record<string, TradingDeskSectionState>
  latestSectionKey: string | null
  debates: TradingDeskDebates
  activity: TradingDeskActivityItem[]
  stats: TradingDeskStats | null
  signal: string | null
  decision: string | null
  llm: {
    provider: string
    deep_think_llm: string
    quick_think_llm: string
    backend_url: string | null
  } | null
  mock: boolean
  error: string | null
  startedAt: number
}

const EMPTY_DEBATES: TradingDeskDebates = {
  research: { bull: "", bear: "", judge: "" },
  risk: { aggressive: "", conservative: "", neutral: "", judge: "" },
}

const MAX_ACTIVITY = 8
// Stop polling a background job after this long, so a job stuck in a
// non-terminal state never polls forever when the tab is left open.
const JOB_POLL_TIMEOUT_MS = 15 * 60 * 1000

function seedAgentStatus(
  teams: TradingDeskTeam[],
  analysts: string[]
): Record<string, TradingDeskAgentStatus> {
  const status: Record<string, TradingDeskAgentStatus> = {}
  for (const team of teams) {
    for (const agent of team.agents) {
      if (agent.selectable && !analysts.includes(agent.key)) {
        continue
      }
      status[agent.name] = "pending"
    }
  }
  return status
}

function initialRunState(request: TradingDeskRequest): TradingDeskRunState {
  return {
    status: "running",
    ticker: request.ticker.toUpperCase(),
    tradeDate: request.tradeDate ?? null,
    teams: TRADING_DESK_DEFAULT_TEAMS,
    agentStatus: seedAgentStatus(TRADING_DESK_DEFAULT_TEAMS, request.analysts),
    sections: {},
    latestSectionKey: null,
    debates: EMPTY_DEBATES,
    activity: [],
    stats: null,
    signal: null,
    decision: null,
    llm: null,
    mock: false,
    error: null,
    startedAt: Date.now(),
  }
}

function applyEvent(
  state: TradingDeskRunState,
  event: TradingDeskEvent,
  activityCounter: { current: number }
): TradingDeskRunState {
  switch (event.type) {
    case "run_started": {
      const teams = event.teams.length > 0 ? event.teams : state.teams
      return {
        ...state,
        teams,
        ticker: event.ticker,
        tradeDate: event.trade_date,
        llm: event.llm,
        mock: event.mock,
        // Re-seed against the authoritative roster + selected analysts.
        agentStatus: {
          ...seedAgentStatus(teams, event.analysts),
          ...state.agentStatus,
        },
      }
    }
    case "agent_status": {
      return {
        ...state,
        agentStatus: { ...state.agentStatus, [event.agent]: event.status },
      }
    }
    case "report_section": {
      const existing = state.sections[event.section]
      return {
        ...state,
        latestSectionKey: event.section,
        sections: {
          ...state.sections,
          [event.section]: {
            key: event.section,
            title: event.title,
            team: event.team,
            content: event.content,
            order: existing?.order ?? Object.keys(state.sections).length,
          },
        },
      }
    }
    case "debate_update": {
      const debate = state.debates[event.debate]
      return {
        ...state,
        debates: {
          ...state.debates,
          [event.debate]: { ...debate, [event.role]: event.content },
        },
      }
    }
    case "tool_call": {
      activityCounter.current += 1
      const argSummary =
        event.args && typeof event.args === "object"
          ? Object.entries(event.args as Record<string, unknown>)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(", ")
          : ""
      const item: TradingDeskActivityItem = {
        id: activityCounter.current,
        kind: "tool",
        agent: event.agent,
        text: argSummary ? `${event.tool}(${argSummary})` : event.tool,
      }
      return {
        ...state,
        activity: [item, ...state.activity].slice(0, MAX_ACTIVITY),
      }
    }
    case "activity": {
      activityCounter.current += 1
      const item: TradingDeskActivityItem = {
        id: activityCounter.current,
        kind: event.kind,
        agent: event.agent,
        text: event.content,
      }
      return {
        ...state,
        activity: [item, ...state.activity].slice(0, MAX_ACTIVITY),
      }
    }
    case "stats": {
      return {
        ...state,
        stats: {
          llm_calls: event.llm_calls,
          tool_calls: event.tool_calls,
          tokens_in: event.tokens_in,
          tokens_out: event.tokens_out,
          elapsed_seconds: event.elapsed_seconds,
        },
      }
    }
    case "run_completed": {
      // Adopt the authoritative final sections + debates.
      const sections = { ...state.sections }
      let order = Object.keys(sections).length
      for (const [key, content] of Object.entries(event.report) as [
        string,
        string,
      ][]) {
        if (!content) {
          continue
        }
        const prev = sections[key]
        sections[key] = {
          key,
          title: prev?.title ?? key,
          team: prev?.team ?? "analysts",
          content,
          order: prev?.order ?? order++,
        }
      }
      // In background mode only the final event arrives (no incremental
      // agent_status), so mark the whole roster complete on finish.
      const agentStatus: Record<string, TradingDeskAgentStatus> = {}
      for (const name of Object.keys(state.agentStatus)) {
        agentStatus[name] = "completed"
      }
      return {
        ...state,
        status: "completed",
        signal: event.signal || state.signal,
        decision: event.decision || state.decision,
        debates: event.debates,
        sections,
        agentStatus,
        stats: event.stats,
      }
    }
    case "error": {
      return { ...state, status: "error", error: event.message }
    }
    case "done": {
      // Clean end-of-stream sentinel. Only flip to completed if we were still
      // running and didn't already see a terminal event.
      if (state.status === "running") {
        return { ...state, status: "completed" }
      }
      return state
    }
    default:
      return state
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string }
    if (data.error) {
      return data.error
    }
  } catch {
    // fall through
  }
  return `Request failed (${String(response.status)}).`
}

export function useTradingDeskRun() {
  const [state, setState] = useState<TradingDeskRunState | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activityCounterRef = useRef({ current: 0 })

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState((prev) =>
      prev?.status === "running" ? { ...prev, status: "stopped" } : prev
    )
  }, [])

  const start = useCallback(async (request: TradingDeskRequest) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    activityCounterRef.current = { current: 0 }
    setState(initialRunState(request))

    try {
      const response = await fetch("/api/trading-desk/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const message = await readErrorMessage(response)
        setState((prev) =>
          prev ? { ...prev, status: "error", error: message } : prev
        )
        return
      }

      await readResponseStreamLines(response.body, (line) => {
        const event = parseTradingDeskEventLine(line)
        if (!event) {
          return
        }
        setState((prev) =>
          prev ? applyEvent(prev, event, activityCounterRef.current) : prev
        )
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "The analysis stream failed.",
            }
          : prev
      )
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }, [])

  // Background mode: kick off an async job and poll for the final result.
  // Resilient to a held connection dropping; loses live per-agent streaming
  // (the pipeline fills in once the job completes).
  const startJob = useCallback(async (request: TradingDeskRequest) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    activityCounterRef.current = { current: 0 }
    setState(initialRunState(request))

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))

    const fail = (message: string) => {
      setState((prev) =>
        prev ? { ...prev, status: "error", error: message } : prev
      )
    }

    // Read through a function so control-flow narrowing doesn't treat the flag
    // as constant across the awaited sleep (it can flip during the wait).
    const isAborted = () => controller.signal.aborted

    try {
      const response = await fetch("/api/trading-desk/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        fail(await readErrorMessage(response))
        return
      }
      const { jobId } = (await response.json()) as { jobId?: string }
      if (!jobId) {
        fail("The analysis job could not be started.")
        return
      }

      const pollDeadline = Date.now() + JOB_POLL_TIMEOUT_MS
      for (;;) {
        if (isAborted()) {
          return
        }
        if (Date.now() > pollDeadline) {
          fail("The analysis timed out.")
          return
        }
        await sleep(2500)
        if (isAborted()) {
          return
        }
        const pollResponse = await fetch(`/api/jobs/${jobId}`, {
          signal: controller.signal,
          cache: "no-store",
        })
        if (!pollResponse.ok) {
          fail(await readErrorMessage(pollResponse))
          return
        }
        const { job } = (await pollResponse.json()) as {
          job?: { status: string; result?: unknown; error?: string | null }
        }
        if (!job) {
          fail("The analysis job was not found.")
          return
        }
        if (job.status === "completed") {
          const result = job.result
          setState((prev) => {
            if (!prev) {
              return prev
            }
            if (
              result &&
              typeof result === "object" &&
              (result as { type?: unknown }).type === "run_completed"
            ) {
              return applyEvent(
                prev,
                result as TradingDeskEvent,
                activityCounterRef.current
              )
            }
            return { ...prev, status: "completed" }
          })
          return
        }
        if (job.status === "failed") {
          fail(job.error ?? "The analysis failed.")
          return
        }
      }
    } catch (error) {
      if (isAborted()) {
        return
      }
      fail(error instanceof Error ? error.message : "The analysis job failed.")
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }, [])

  return {
    state,
    start,
    startJob,
    stop,
    isRunning: state?.status === "running",
  }
}
