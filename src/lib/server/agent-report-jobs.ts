import { updateAgentJobStatus } from "@/lib/server/jobs"

interface ReportPlaceholderParams {
  jobId: string
  reportId?: string
  threadId?: string
  title?: string
}

export function buildReportPlaceholderResult(params: ReportPlaceholderParams) {
  return {
    title: params.title ?? "Async report",
    reportId: params.reportId ?? null,
    threadId: params.threadId ?? null,
    message:
      "Report job accepted. Connect this function to the agent runtime to generate the final artifact.",
  }
}

export async function completeReportPlaceholderJob(
  params: ReportPlaceholderParams
) {
  await updateAgentJobStatus({
    jobId: params.jobId,
    status: "running",
  })

  const result = buildReportPlaceholderResult(params)
  await updateAgentJobStatus({
    jobId: params.jobId,
    status: "completed",
    result,
  })

  return result
}
