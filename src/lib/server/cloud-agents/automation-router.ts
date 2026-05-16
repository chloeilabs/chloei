import { createLogger } from "@/lib/logger"
import { CLOUD_AGENT_MAX_CONCURRENT_PER_USER } from "@/lib/server/agent-runtime-config"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"

import { dispatchCloudAgentTaskRequested } from "./dispatcher"
import { listCloudAgentEnvironments } from "./environments"
import { CloudAgentTransitionError } from "./errors"
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

  const flags = await resolveAgentFeatureFlags()
  if (!flags.cloudAgentsAutomationsEnabled) {
    return {
      skipped: true,
      reason:
        "Cloud agent automations are disabled (AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED is not set).",
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

  let task
  try {
    task = await createCloudAgentTask({
      userId,
      environmentId: target.id,
      prompt: params.prompt,
      maxConcurrentPerUser: CLOUD_AGENT_MAX_CONCURRENT_PER_USER,
    })
  } catch (error) {
    if (error instanceof CloudAgentTransitionError) {
      return {
        skipped: true,
        reason: `Cloud agent concurrency limit (${String(CLOUD_AGENT_MAX_CONCURRENT_PER_USER)}) reached for user ${userId}.`,
      }
    }
    throw error
  }
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
