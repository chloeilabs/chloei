import { createLogger } from "@/lib/logger"
import { updateAgentJobStatus } from "@/lib/server/jobs"
import type { TradingDeskRequest } from "@/lib/shared/trading-agents/types"

import { fetchTradingDeskResult } from "./client"

export const TRADING_ANALYSIS_JOB_TYPE = "trading/analysis.requested" as const

const logger = createLogger("trading-desk-job")

/**
 * Execute a Trading Desk analysis as a background job, persisting progress to
 * the shared `agent_job` table. Runs the analysis to completion via the sidecar
 * and stores the final `run_completed` payload as the job result. Always
 * resolves — failures are recorded on the job, never thrown — so it is safe to
 * call fire-and-forget from the inline fallback or awaited from an Inngest step.
 */
export async function runTradingAnalysisJob(params: {
  jobId: string
  request: TradingDeskRequest
}): Promise<{ jobId: string; status: "completed" | "failed" }> {
  const { jobId, request } = params
  try {
    await updateAgentJobStatus({ jobId, status: "running" })
    const result = await fetchTradingDeskResult(request)
    await updateAgentJobStatus({ jobId, status: "completed", result })
    return { jobId, status: "completed" }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The analysis failed."
    logger.error("Trading analysis job failed.", { error, jobId })
    try {
      await updateAgentJobStatus({ jobId, status: "failed", error: message })
    } catch (statusError) {
      logger.error("Failed to mark trading analysis job as failed.", {
        error: statusError,
        jobId,
      })
    }
    return { jobId, status: "failed" }
  }
}
