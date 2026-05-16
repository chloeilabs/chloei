import { z } from "zod"

import { completeReportPlaceholderJob } from "@/lib/server/agent-report-jobs"
import {
  continueCloudAgentTaskAfterApproval,
  startCloudAgentTaskRun,
} from "@/lib/server/cloud-agents/runtime"
import { indexUploadedDocument } from "@/lib/server/knowledge-indexing"

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

const cloudAgentTaskRequestedSchema = z
  .object({
    userId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
  })
  .strict()

const cloudAgentApprovalReceivedSchema = z
  .object({
    userId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    approved: z.boolean(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict()

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

export const cloudAgentTaskRequested = inngest.createFunction(
  {
    id: "cloud-agent-task-requested",
    idempotency: "event.data.userId + ':' + event.data.taskId",
    triggers: [{ event: "cloud-agent/task.requested" }],
  },
  async ({ event, step }) => {
    const data = cloudAgentTaskRequestedSchema.parse(event.data)
    return step.run("start-cloud-agent-task-run", () =>
      startCloudAgentTaskRun(data)
    )
  }
)

export const cloudAgentApprovalReceived = inngest.createFunction(
  {
    id: "cloud-agent-approval-received",
    idempotency: "event.data.userId + ':' + event.data.taskId",
    triggers: [{ event: "cloud-agent/approval.received" }],
  },
  async ({ event, step }) => {
    const data = cloudAgentApprovalReceivedSchema.parse(event.data)
    return step.run("continue-cloud-agent-task-after-approval", () =>
      continueCloudAgentTaskAfterApproval(data)
    )
  }
)

export const inngestFunctions = [
  documentUploaded,
  reportRequested,
  watchlistRefreshRequested,
  cloudAgentTaskRequested,
  cloudAgentApprovalReceived,
]
