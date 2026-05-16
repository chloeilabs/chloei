import { createLogger } from "@/lib/logger"

import { dispatchCloudAgentTaskRequested } from "./dispatcher"
import { listCloudAgentEnvironments } from "./environments"
import { appendCloudAgentTaskEvent } from "./events"
import { createCloudAgentTask } from "./tasks"

const logger = createLogger("cloud-agent-automation")

export function resolveCloudAgentAutomationUserId(): string | null {
  const explicit = process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID?.trim()
  return explicit && explicit.length > 0 ? explicit : null
}

export async function routeAutomationTriggerToCloudAgent(params: {
  repoOwner: string
  repoName: string
  prompt: string
  source: string
}): Promise<{ taskId: string } | { skipped: true; reason: string }> {
  const userId = resolveCloudAgentAutomationUserId()
  if (!userId) {
    return {
      skipped: true,
      reason:
        "AGENT_CLOUD_AGENT_AUTOMATION_USER_ID is not configured; automation triggers will be ignored.",
    }
  }

  const environments = await listCloudAgentEnvironments(userId)
  const target = environments.find(
    (environment) =>
      environment.repoOwner.toLowerCase() === params.repoOwner.toLowerCase() &&
      environment.repoName.toLowerCase() === params.repoName.toLowerCase()
  )
  if (!target) {
    return {
      skipped: true,
      reason: `No cloud agent environment configured for ${params.repoOwner}/${params.repoName}.`,
    }
  }

  const task = await createCloudAgentTask({
    userId,
    environmentId: target.id,
    prompt: params.prompt,
  })
  await appendCloudAgentTaskEvent({
    userId,
    taskId: task.id,
    payload: {
      kind: "status",
      status: "queued",
      phase: `Triggered by ${params.source}`,
    },
  })
  await dispatchCloudAgentTaskRequested({ userId, taskId: task.id })
  logger.info("Routed automation trigger to cloud agent task.", {
    userId,
    taskId: task.id,
    source: params.source,
  })
  return { taskId: task.id }
}
