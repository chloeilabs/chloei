import { createLogger } from "@/lib/logger"
import { inngest } from "@/lib/server/inngest/client"
import {
  shouldRunInngestInlineFallback,
  shouldSendInngestEvents,
} from "@/lib/server/inngest/environment"

import {
  continueCloudAgentTaskAfterApproval,
  startCloudAgentTaskRun,
} from "./runtime"

const logger = createLogger("cloud-agent-dispatcher")

function shouldDispatchInline(): boolean {
  if (shouldRunInngestInlineFallback()) {
    return true
  }
  return !shouldSendInngestEvents()
}

function runInBackground(label: string, work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => {
    logger.error(`Inline cloud agent dispatch failed: ${label}.`, { error })
  })
}

export async function dispatchCloudAgentTaskRequested(params: {
  userId: string
  taskId: string
}): Promise<{ delivery: "inline" | "inngest" }> {
  if (shouldDispatchInline()) {
    runInBackground("startCloudAgentTaskRun", () =>
      startCloudAgentTaskRun(params)
    )
    return { delivery: "inline" }
  }

  await inngest.send({
    id: `cloud-agent/task.requested:${params.userId}:${params.taskId}`,
    name: "cloud-agent/task.requested",
    data: params,
  })
  return { delivery: "inngest" }
}

export async function dispatchCloudAgentApprovalReceived(params: {
  userId: string
  taskId: string
  approved: boolean
  note?: string
}): Promise<{ delivery: "inline" | "inngest" }> {
  if (shouldDispatchInline()) {
    runInBackground("continueCloudAgentTaskAfterApproval", () =>
      continueCloudAgentTaskAfterApproval(params)
    )
    return { delivery: "inline" }
  }

  await inngest.send({
    id: `cloud-agent/approval.received:${params.userId}:${params.taskId}`,
    name: "cloud-agent/approval.received",
    data: params,
  })
  return { delivery: "inngest" }
}
