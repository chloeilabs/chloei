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
    <div className="border border-border bg-card/40">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActive(tab.id)
            }}
            aria-pressed={active === tab.id}
            className={cn(
              "-mb-px cursor-pointer border-b-2 px-3 py-2.5 font-departureMono text-[11px] tracking-wide whitespace-nowrap uppercase transition-colors",
              active === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-6 px-4 py-4 sm:px-5">
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
