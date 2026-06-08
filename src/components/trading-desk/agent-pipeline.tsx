"use client"

import { Check, ChevronDown, Loader2 } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type {
  TradingDeskAgentStatus,
  TradingDeskTeam,
} from "@/lib/shared/trading-agents/types"
import { cn } from "@/lib/utils"

function StatusDot({ status }: { status: TradingDeskAgentStatus }) {
  if (status === "completed") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-vesper-teal">
        <Check className="size-3.5" strokeWidth={2.5} />
      </span>
    )
  }
  if (status === "in_progress") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-primary">
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    )
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
    </span>
  )
}

/** Collapsible pipeline: a one-line progress summary that expands to the full
 *  roster grouped by team. */
export function AgentPipeline({
  teams,
  agentStatus,
  defaultOpen = false,
}: {
  teams: TradingDeskTeam[]
  agentStatus: Record<string, TradingDeskAgentStatus>
  defaultOpen?: boolean
}) {
  const statuses = Object.values(agentStatus)
  const total = statuses.length
  const done = statuses.filter((s) => s === "completed").length
  const allDone = total > 0 && done === total

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-y border-border/70"
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 py-3 text-left">
        <span className="flex items-center gap-2">
          {allDone ? (
            <Check className="size-3.5 text-vesper-teal" strokeWidth={2.5} />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-primary" />
          )}
          <span className="font-departureMono text-[11px] tracking-wide text-muted-foreground uppercase">
            Agent pipeline
          </span>
          <span className="text-xs text-muted-foreground">
            {done}/{total}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border/70 py-4 sm:grid-cols-2 lg:grid-cols-5">
          {teams.map((team) => {
            const agents = team.agents.filter(
              (agent) => agentStatus[agent.name] !== undefined
            )
            if (agents.length === 0) {
              return null
            }
            return (
              <div key={team.id}>
                <div className="mb-2 font-departureMono text-[10px] tracking-wide text-muted-foreground uppercase">
                  {team.label}
                </div>
                <ul className="space-y-1.5">
                  {agents.map((agent) => {
                    const status = agentStatus[agent.name] ?? "pending"
                    return (
                      <li
                        key={agent.name}
                        className={cn(
                          "flex items-center gap-2 text-sm",
                          status === "pending" && "text-muted-foreground",
                          status === "in_progress" &&
                            "font-medium text-foreground",
                          status === "completed" && "text-foreground/90"
                        )}
                      >
                        <StatusDot status={status} />
                        <span className="truncate">{agent.name}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
