"use client"

import { useState } from "react"

import type { TradingDeskDebates } from "@/lib/shared/trading-agents/types"
import { cn } from "@/lib/utils"

import { ReportMarkdown } from "./report-markdown"
import type { TradingDeskSectionState } from "./use-trading-desk-run"

const TABS = [
  { id: "analysts", label: "Analysts" },
  { id: "research", label: "Research" },
  { id: "trading", label: "Trading" },
  { id: "risk", label: "Risk" },
] as const
type TabId = (typeof TABS)[number]["id"]

const DEBATE_ROLE_STYLES: Record<string, string> = {
  bull: "text-vesper-teal",
  bear: "text-destructive",
  aggressive: "text-vesper-orange",
  conservative: "text-muted-foreground",
  neutral: "text-muted-foreground",
  judge: "text-foreground",
}

function Section({
  title,
  content,
  idKey,
}: {
  title: string
  content: string | undefined
  idKey: string
}) {
  const value = content?.trim()
  if (!value) {
    return null
  }
  return (
    <section className="space-y-2">
      <h3 className="font-departureMono text-[11px] tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ReportMarkdown
        content={value}
        id={`td-${idKey}`}
        showSourceFavicon={false}
      />
    </section>
  )
}

function DebateBlock({
  label,
  roleKey,
  content,
  idPrefix,
}: {
  label: string
  roleKey: string
  content: string
  idPrefix: string
}) {
  if (!content.trim()) {
    return null
  }
  return (
    <section className="space-y-2">
      <h3
        className={cn(
          "font-departureMono text-[11px] tracking-wide uppercase",
          DEBATE_ROLE_STYLES[roleKey] ?? "text-foreground"
        )}
      >
        {label}
      </h3>
      <ReportMarkdown
        content={content}
        id={`${idPrefix}-${roleKey}`}
        showSourceFavicon={false}
      />
    </section>
  )
}

function EmptyTab({ label }: { label: string }) {
  return (
    <p className="py-2 text-sm text-muted-foreground">
      No {label} available for this run.
    </p>
  )
}

export function ReportPanel({
  sections,
  debates,
}: {
  sections: Record<string, TradingDeskSectionState>
  debates: TradingDeskDebates
}) {
  const [active, setActive] = useState<TabId>("analysts")
  const activeIndex = TABS.findIndex((tab) => tab.id === active)

  const research = debates.research
  const risk = debates.risk
  const analystKeys = [
    { key: "market_report", title: "Market Analysis" },
    { key: "sentiment_report", title: "Social Sentiment" },
    { key: "news_report", title: "News Analysis" },
    { key: "fundamentals_report", title: "Fundamentals" },
  ]
  const hasAnalysts = analystKeys.some((a) => sections[a.key]?.content)
  const hasResearch = Boolean(
    research.bull ||
    research.bear ||
    research.judge ||
    sections.investment_plan?.content
  )
  const trader = sections.trader_investment_plan?.content
  const hasRisk = Boolean(
    risk.aggressive ||
    risk.conservative ||
    risk.neutral ||
    risk.judge ||
    sections.final_trade_decision?.content
  )

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div
          role="tablist"
          aria-label="Trading desk report sections"
          className="relative grid h-10 min-w-[25rem] grid-cols-4 overflow-hidden border border-border bg-background p-1 sm:w-fit"
        >
          <div
            aria-hidden="true"
            className="absolute inset-y-1 left-1 bg-primary/20 shadow-[inset_0_0_0_1px_var(--primary)] transition-transform"
            style={{
              width: "calc((100% - 0.5rem) / 4)",
              transform: `translateX(${String(activeIndex * 100)}%)`,
            }}
          />
          {TABS.map((tab, index) => {
            const isActive = active === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  setActive(tab.id)
                }}
                className={cn(
                  "relative h-full min-w-0 cursor-pointer bg-transparent px-3 font-departureMono text-[11px] tracking-wide whitespace-nowrap uppercase transition-colors hover:bg-muted/55",
                  index > 0 &&
                    "before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-6">
        {active === "analysts" &&
          (hasAnalysts ? (
            analystKeys.map((a) => (
              <Section
                key={a.key}
                title={a.title}
                content={sections[a.key]?.content}
                idKey={a.key}
              />
            ))
          ) : (
            <EmptyTab label="analyst reports" />
          ))}

        {active === "research" &&
          (hasResearch ? (
            research.bull || research.bear || research.judge ? (
              <>
                <DebateBlock
                  label="Bull Researcher"
                  roleKey="bull"
                  content={research.bull}
                  idPrefix="research"
                />
                <DebateBlock
                  label="Bear Researcher"
                  roleKey="bear"
                  content={research.bear}
                  idPrefix="research"
                />
                <DebateBlock
                  label="Research Manager — Decision"
                  roleKey="judge"
                  content={research.judge}
                  idPrefix="research"
                />
              </>
            ) : (
              <Section
                title="Research Team Decision"
                content={sections.investment_plan?.content}
                idKey="investment_plan"
              />
            )
          ) : (
            <EmptyTab label="research debate" />
          ))}

        {active === "trading" &&
          (trader ? (
            <Section
              title="Trading Plan"
              content={trader}
              idKey="trader_investment_plan"
            />
          ) : (
            <EmptyTab label="trading plan" />
          ))}

        {active === "risk" &&
          (hasRisk ? (
            risk.aggressive ||
            risk.conservative ||
            risk.neutral ||
            risk.judge ? (
              <>
                <DebateBlock
                  label="Aggressive Analyst"
                  roleKey="aggressive"
                  content={risk.aggressive}
                  idPrefix="risk"
                />
                <DebateBlock
                  label="Conservative Analyst"
                  roleKey="conservative"
                  content={risk.conservative}
                  idPrefix="risk"
                />
                <DebateBlock
                  label="Neutral Analyst"
                  roleKey="neutral"
                  content={risk.neutral}
                  idPrefix="risk"
                />
                <DebateBlock
                  label="Portfolio Manager — Final Call"
                  roleKey="judge"
                  content={risk.judge}
                  idPrefix="risk"
                />
              </>
            ) : (
              <Section
                title="Portfolio Decision"
                content={sections.final_trade_decision?.content}
                idKey="final_trade_decision"
              />
            )
          ) : (
            <EmptyTab label="risk debate" />
          ))}
      </div>
    </div>
  )
}
