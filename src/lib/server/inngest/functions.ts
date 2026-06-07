import { z } from "zod"

import { createLogger } from "@/lib/logger"
import { completeReportPlaceholderJob } from "@/lib/server/agent-report-jobs"
import { updateAgentJobStatus } from "@/lib/server/jobs"
import { indexUploadedDocument } from "@/lib/server/knowledge-indexing"
import { runTradingAnalysisJob } from "@/lib/server/trading-agents/jobs"
import { tradingDeskRequestSchema } from "@/lib/server/trading-agents/request-schema"

import { inngest } from "./client"

const logger = createLogger("inngest-functions")

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

const opsInngestSmokeSchema = z.object({
  smokeId: z.string().trim().min(1),
  sentAt: z.string().trim().min(1),
  source: z.literal("chloei_inngest_smoke").optional(),
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
    // The whole analysis runs in one long synchronous step, so cap retries: a
    // hard platform-kill (e.g. exceeding maxDuration) must not re-run the whole
    // expensive multi-agent analysis several times over.
    retries: 1,
    // Safety net. runTradingAnalysisJob records its own failures, but if the
    // invocation is hard-killed before its catch can run, the job row would sit
    // in "running" until the client's 15-min poll cap. Mark it failed so the UI
    // surfaces the error promptly. The original event is nested under
    // `event.data.event` on the function.failed payload.
    onFailure: async ({ event }) => {
      const failure = event.data as {
        event?: { data?: { jobId?: unknown } }
        error?: { message?: unknown }
      }
      const jobId =
        typeof failure.event?.data?.jobId === "string"
          ? failure.event.data.jobId
          : null
      if (!jobId) {
        logger.warn(
          "Trading analysis onFailure could not extract a jobId from the failure payload.",
          { eventData: failure.event?.data }
        )
        return
      }
      const message =
        typeof failure.error?.message === "string"
          ? failure.error.message
          : "The analysis did not complete."
      await updateAgentJobStatus({
        jobId,
        status: "failed",
        error: message,
      }).catch((updateError: unknown) => {
        logger.error(
          "Failed to mark trading analysis job as failed in onFailure handler",
          { jobId, error: updateError }
        )
      })
    },
    triggers: [{ event: "trading/analysis.requested" }],
  },
  async ({ event, step }) => {
    const data = tradingAnalysisRequestedSchema.parse(event.data)
    return step.run("run-trading-analysis", () =>
      runTradingAnalysisJob({ jobId: data.jobId, request: data.request })
    )
  }
)

export const opsInngestSmoke = inngest.createFunction(
  {
    id: "ops-inngest-smoke",
    idempotency: "event.data.smokeId",
    triggers: [{ event: "ops/inngest.smoke" }],
  },
  async ({ event, step }) => {
    const data = opsInngestSmokeSchema.parse(event.data)
    return step.run("record-smoke", () => ({
      ok: true,
      sentAt: data.sentAt,
      smokeId: data.smokeId,
      source: data.source ?? "chloei_inngest_smoke",
    }))
  }
)

export const inngestFunctions = [
  documentUploaded,
  reportRequested,
  watchlistRefreshRequested,
  tradingAnalysisRequested,
  opsInngestSmoke,
]
