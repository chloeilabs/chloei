import { z } from "zod"

import { updateAgentJobStatus } from "@/lib/server/jobs"

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

export const documentUploaded = inngest.createFunction(
  {
    id: "knowledge-document-uploaded",
    idempotency: "event.data.userId + ':' + event.data.documentId",
    triggers: [{ event: "knowledge/document.uploaded" }],
  },
  async ({ event, step }) => {
    const data = documentUploadedSchema.parse(event.data)
    await step.run("record-document-metadata", () => data)
    return {
      indexed: false,
      reason:
        "Binary uploaded; text extraction/indexing should run after a parser extracts governed text chunks.",
    }
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
    await step.run("mark-running", () =>
      updateAgentJobStatus({
        jobId: data.jobId,
        status: "running",
      })
    )

    const result = await step.run("prepare-report-placeholder", () => ({
      title: data.title ?? "Async report",
      reportId: data.reportId ?? null,
      threadId: data.threadId ?? null,
      message:
        "Report job accepted. Connect this function to the agent runtime to generate the final artifact.",
    }))

    await step.run("mark-completed", () =>
      updateAgentJobStatus({
        jobId: data.jobId,
        status: "completed",
        result,
      })
    )

    return result
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

export const inngestFunctions = [
  documentUploaded,
  reportRequested,
  watchlistRefreshRequested,
]
