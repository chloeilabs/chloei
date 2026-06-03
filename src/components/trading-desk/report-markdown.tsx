"use client"

import dynamic from "next/dynamic"

/**
 * Reuse Chloei's chat markdown renderer for report sections. Dynamically
 * imported (ssr: false) exactly like the assistant message renderer so the
 * heavy markdown/shiki/katex bundle stays out of the initial load.
 */
export const ReportMarkdown = dynamic(
  () =>
    import("@/components/agent/markdown/memoized-markdown").then(
      (mod) => mod.MemoizedMarkdown
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-4 w-40 animate-pulse rounded bg-muted/50" />
    ),
  }
)
