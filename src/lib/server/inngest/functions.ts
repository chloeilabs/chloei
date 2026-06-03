import { z } from "zod"

import { completeReportPlaceholderJob } from "@/lib/server/agent-report-jobs"
import { indexUploadedDocument } from "@/lib/server/knowledge-indexing"
import { runTradingAnalysisJob } from "@/lib/server/trading-agents/jobs"
import { tradingDeskRequestSchema } from "@/lib/server/trading-agents/request-schema"

import { inngest } from "./client"

const documentUploadedSchema = z.object({
  userId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  pathname: z.string().trim().min(1),
  filename: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i),
})

const reportRequestedSchema = z.object({
  userId: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
  reportId: z.uuid().optional(),
  threadId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(200).optional(),
})

const watchlistRefreshSchema = z.object({
  userId: z.string().trim().min(1),
  watchlistId: z.string().trim().min(1),
})

const tradingAnalysisRequestedSchema = z.object({
  userId: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
  request: tradingDeskRequestSchema,
})

export const documentUploaded = inngest.createFunction(
  {
    id: "knowledge-document-uploaded",
    idempotency: "event.data.userId + ':' + event.data.documentId",
    triggers: [{ event: "knowledge/document.uploaded" }],
  },
  async ({ event, step }) => {
    const data = documentUploadedSchema.parse(event.data)
    await step.run("record-document-metadata", () => data)
    return step.run("index-uploaded-document", () =>
      indexUploadedDocument(data)
    )
  }
)

export const reportRequested = inngest.createFunction(
  {
    id: "agent-report-requested",
    idempotency: "event.data.userId + ':' + event.data.jobId",
    triggers: [{ event: "agent/report.requested" }],
  },
  async ({ event, step }) => {
    const data = reportRequestedSchema.parse(event.data)
    return step.run("complete-report-placeholder", () =>
      completeReportPlaceholderJob({
        jobId: data.jobId,
        reportId: data.reportId,
        threadId: data.threadId,
        title: data.title,
      })
    )
  }
)

export const watchlistRefreshRequested = inngest.createFunction(
  {
    id: "market-watchlist-refresh-requested",
    idempotency: "event.data.userId + ':' + event.data.watchlistId",
    triggers: [{ event: "market/watchlist.refresh.requested" }],
  },
  async ({ event, step }) => {
    const data = watchlistRefreshSchema.parse(event.data)
    return step.run("refresh-placeholder", () => ({
      refreshed: false,
      watchlistId: data.watchlistId,
      reason:
        "Watchlist refresh is reserved for the finance workflow rollout and should use finance_data/FRED/SEC providers.",
    }))
  }
)

export const tradingAnalysisRequested = inngest.createFunction(
  {
    id: "trading-analysis-requested",
    idempotency: "event.data.userId + ':' + event.data.jobId",
    triggers: [{ event: "trading/analysis.requested" }],
  },
  async ({ event, step }) => {
    const data = tradingAnalysisRequestedSchema.parse(event.data)
    return step.run("run-trading-analysis", () =>
      runTradingAnalysisJob({ jobId: data.jobId, request: data.request })
    )
  }
)

export const inngestFunctions = [
  documentUploaded,
  reportRequested,
  watchlistRefreshRequested,
  tradingAnalysisRequested,
]
