import { createLogger } from "@/lib/logger"
import {
  type CloudAgentApprovalAction,
  type CloudAgentEnvironment,
  type CloudAgentEvent,
  deriveCloudAgentTaskBranchName,
} from "@/lib/shared/cloud-agents"

import { requestCloudAgentApproval } from "./approvals"
import { createCloudAgentArtifact } from "./artifacts"
import { getCloudAgentEnvironment } from "./environments"
import { appendCloudAgentTaskEvent } from "./events"
import { startCloudAgentTaskRunWithLlm } from "./llm-runtime"
import { fakeCloudAgentSandboxAdapter } from "./sandbox/fake"
import type { CloudAgentSandboxAdapter } from "./sandbox/types"
import {
  isVercelSandboxConfigured,
  vercelCloudAgentSandboxAdapter,
} from "./sandbox/vercel"
import {
  type CloudAgentTaskUpdate,
  getCloudAgentTask,
  updateCloudAgentTask,
} from "./tasks"

const logger = createLogger("cloud-agent-runtime")

export type CloudAgentRuntimeMode = "fake" | "real"
export type CloudAgentRuntimeType = "scripted" | "llm"

export function resolveCloudAgentRuntimeMode(): CloudAgentRuntimeMode {
  const envMode = process.env.CLOUD_AGENT_RUNTIME_MODE?.trim().toLowerCase()
  if (envMode === "real") {
    return "real"
  }
  return "fake"
}

export function resolveCloudAgentRuntimeType(): CloudAgentRuntimeType {
  const envType = process.env.CLOUD_AGENT_RUNTIME_TYPE?.trim().toLowerCase()
  if (envType === "llm" && process.env.AI_GATEWAY_API_KEY) {
    return "llm"
  }
  return "scripted"
}

export function resolveCloudAgentSandboxAdapter(
  mode: CloudAgentRuntimeMode
): CloudAgentSandboxAdapter {
  if (mode === "real") {
    if (isVercelSandboxConfigured()) {
      return vercelCloudAgentSandboxAdapter
    }
    logger.warn(
      "Real cloud agent sandbox adapter requested but Vercel Sandbox env vars are missing; using fake adapter.",
      { mode }
    )
    return fakeCloudAgentSandboxAdapter
  }
  return fakeCloudAgentSandboxAdapter
}

async function emit(params: {
  userId: string
  taskId: string
  event: CloudAgentEvent
}) {
  await appendCloudAgentTaskEvent({
    userId: params.userId,
    taskId: params.taskId,
    payload: params.event,
  })
}

async function applyStatus(params: {
  userId: string
  taskId: string
  update: CloudAgentTaskUpdate
  phase?: string
}) {
  await updateCloudAgentTask(params.userId, params.taskId, {
    ...params.update,
    ...(params.phase !== undefined ? { phase: params.phase } : {}),
  })
  if (params.update.status) {
    await emit({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "status",
        status: params.update.status,
        ...(params.phase ? { phase: params.phase } : {}),
      },
    })
  }
}

interface RunInput {
  userId: string
  taskId: string
}

async function getEnvironmentOrFail(params: {
  userId: string
  taskId: string
  environmentId: string
}): Promise<CloudAgentEnvironment | null> {
  const environment = await getCloudAgentEnvironment(
    params.userId,
    params.environmentId
  )
  if (!environment) {
    await applyStatus({
      userId: params.userId,
      taskId: params.taskId,
      update: {
        status: "failed",
        error: "Environment not found.",
      },
    })
    await emit({
      userId: params.userId,
      taskId: params.taskId,
      event: {
        kind: "error",
        message: "Environment not found for this task.",
        errorCode: "CLOUD_AGENT_ENVIRONMENT_MISSING",
        retryable: false,
      },
    })
    return null
  }
  return environment
}

async function failTask(params: {
  userId: string
  taskId: string
  error: unknown
  errorCode?: string
}) {
  const message =
    params.error instanceof Error
      ? params.error.message
      : "Unknown cloud agent failure."
  logger.error("Cloud agent task run failed.", {
    userId: params.userId,
    taskId: params.taskId,
    error: params.error,
  })
  await applyStatus({
    userId: params.userId,
    taskId: params.taskId,
    update: { status: "failed", error: message },
  })
  await emit({
    userId: params.userId,
    taskId: params.taskId,
    event: {
      kind: "error",
      message,
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
      retryable: false,
    },
  })
}

export async function startCloudAgentTaskRun(input: RunInput): Promise<void> {
  const task = await getCloudAgentTask(input.userId, input.taskId)
  if (!task) {
    logger.warn("Cloud agent task disappeared before runtime started.", input)
    return
  }
  if (task.status !== "queued") {
    logger.info("Cloud agent task is not in queued state; skipping run.", {
      ...input,
      status: task.status,
    })
    return
  }

  const environment = await getEnvironmentOrFail({
    userId: input.userId,
    taskId: input.taskId,
    environmentId: task.environmentId,
  })
  if (!environment) {
    return
  }

  const mode = resolveCloudAgentRuntimeMode()
  const adapter = resolveCloudAgentSandboxAdapter(mode)

  if (resolveCloudAgentRuntimeType() === "llm") {
    const aiGatewayApiKey = process.env.AI_GATEWAY_API_KEY
    if (aiGatewayApiKey) {
      await startCloudAgentTaskRunWithLlm({
        userId: input.userId,
        taskId: input.taskId,
        adapter,
        aiGatewayApiKey,
      })
      return
    }
    logger.warn(
      "CLOUD_AGENT_RUNTIME_TYPE=llm but AI_GATEWAY_API_KEY missing; falling back to scripted runtime.",
      { taskId: input.taskId }
    )
  }

  let sandboxId: string | null = null
  try {
    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "provisioning" },
      phase: "Provisioning sandbox",
    })
    const provisioned = await adapter.provision({
      userId: input.userId,
      taskId: input.taskId,
      repoOwner: environment.repoOwner,
      repoName: environment.repoName,
      baseBranch: environment.baseBranch,
      sandboxRuntime: environment.sandboxRuntime,
    })
    sandboxId = provisioned.sandboxId
    await updateCloudAgentTask(input.userId, input.taskId, { sandboxId })

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "setting_up" },
      phase: "Running setup command",
    })
    if (environment.setupCommand) {
      const setupCallId = `setup-${sandboxId}`
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_call",
          callId: setupCallId,
          toolName: "run_command",
          label: `Setup: ${environment.setupCommand.slice(0, 80)}`,
        },
      })
      const setupResult = await adapter.runSetup({
        sandboxId,
        command: environment.setupCommand,
      })
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "terminal_output",
          stream: setupResult.exitCode === 0 ? "stdout" : "stderr",
          chunk: setupResult.stdout || setupResult.stderr,
          callId: setupCallId,
        },
      })
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_result",
          callId: setupCallId,
          status: setupResult.exitCode === 0 ? "success" : "error",
        },
      })
    }

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "planning" },
      phase: "Planning changes",
    })
    await emit({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "text_delta",
        text: `Plan for "${task.prompt.slice(0, 120)}":\n\n1. Inspect repository layout.\n2. Apply requested edits.\n3. Run tests and summarize.\n`,
      },
    })

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "editing" },
      phase: "Editing files",
    })
    const targetPath = "CLOUD_AGENT_NOTE.md"
    const fileBody = `# Cloud agent note\n\nTask: ${task.prompt}\n\nGenerated by Chloei cloud agent (${mode} runtime).\n`
    const editCallId = `edit-${sandboxId}`
    await emit({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "tool_call",
        callId: editCallId,
        toolName: "write_file",
        label: `Write ${targetPath}`,
      },
    })
    await adapter.writeFile({ sandboxId, path: targetPath, content: fileBody })
    await emit({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "file_change",
        path: targetPath,
        change: "added",
      },
    })
    await emit({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "tool_result",
        callId: editCallId,
        status: "success",
      },
    })
    const diff = await adapter.getDiff({
      sandboxId,
      baseBranch: environment.baseBranch,
    })
    await emit({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "diff_update",
        filesChanged: diff.totals.filesChanged,
        additions: diff.totals.additions,
        deletions: diff.totals.deletions,
      },
    })

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "testing" },
      phase: "Running tests",
    })
    if (environment.testCommand) {
      const testCallId = `test-${sandboxId}`
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_call",
          callId: testCallId,
          toolName: "run_tests",
          label: `Tests: ${environment.testCommand.slice(0, 80)}`,
        },
      })
      const testResult = await adapter.runCommand({
        sandboxId,
        command: environment.testCommand,
      })
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "terminal_output",
          stream: testResult.exitCode === 0 ? "stdout" : "stderr",
          chunk: testResult.stdout || testResult.stderr,
          callId: testCallId,
        },
      })
      await emit({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_result",
          callId: testCallId,
          status: testResult.exitCode === 0 ? "success" : "error",
        },
      })
      if (testResult.exitCode !== 0) {
        await failTask({
          userId: input.userId,
          taskId: input.taskId,
          error: new Error(
            `Tests failed (exit ${String(testResult.exitCode)}). Cloud agent edits were not pushed.`
          ),
          errorCode: "CLOUD_AGENT_TESTS_FAILED",
        })
        if (sandboxId) {
          await adapter.destroy({ sandboxId }).catch(() => undefined)
        }
        return
      }
    }

    const branch = deriveCloudAgentTaskBranchName({
      taskId: input.taskId,
      slug: task.prompt,
    })

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "waiting_for_approval", branch },
      phase: "Waiting for push approval",
    })
    const action: CloudAgentApprovalAction = "push_branch"
    const { event } = requestCloudAgentApproval({
      userId: input.userId,
      taskId: input.taskId,
      action,
      reason: `Push ${String(diff.totals.filesChanged)} file change(s) to ${branch}.`,
    })
    await emit({ userId: input.userId, taskId: input.taskId, event })
  } catch (error) {
    await failTask({
      userId: input.userId,
      taskId: input.taskId,
      error,
      errorCode: "CLOUD_AGENT_RUN_FAILED",
    })
    if (sandboxId) {
      await adapter.destroy({ sandboxId }).catch(() => undefined)
    }
  }
}

export async function continueCloudAgentTaskAfterApproval(input: {
  userId: string
  taskId: string
  approved: boolean
  note?: string
}): Promise<void> {
  const task = await getCloudAgentTask(input.userId, input.taskId)
  if (!task) {
    logger.warn("Cloud agent task disappeared during approval.", input)
    return
  }
  if (task.status !== "waiting_for_approval") {
    logger.info(
      "Cloud agent approval received for task not waiting for approval.",
      { ...input, status: task.status }
    )
    return
  }

  if (!input.approved) {
    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: {
        status: "cancelled",
        summary: input.note ?? "Push denied.",
      },
      phase: "Push denied",
    })
    if (task.sandboxId) {
      const adapter = resolveCloudAgentSandboxAdapter(
        resolveCloudAgentRuntimeMode()
      )
      await adapter
        .destroy({ sandboxId: task.sandboxId })
        .catch(() => undefined)
    }
    return
  }

  const environment = await getEnvironmentOrFail({
    userId: input.userId,
    taskId: input.taskId,
    environmentId: task.environmentId,
  })
  if (!environment) {
    return
  }

  const mode = resolveCloudAgentRuntimeMode()
  const adapter = resolveCloudAgentSandboxAdapter(mode)
  const sandboxId = task.sandboxId
  if (!sandboxId) {
    await failTask({
      userId: input.userId,
      taskId: input.taskId,
      error: new Error("Sandbox id missing on task; cannot push."),
      errorCode: "CLOUD_AGENT_SANDBOX_MISSING",
    })
    return
  }
  const branch =
    task.branch ??
    deriveCloudAgentTaskBranchName({
      taskId: input.taskId,
      slug: task.prompt,
    })

  try {
    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "pushing" },
      phase: "Pushing branch",
    })
    await adapter.createBranchAndPush({
      sandboxId,
      repoOwner: environment.repoOwner,
      repoName: environment.repoName,
      baseBranch: environment.baseBranch,
      branch,
    })
    const pr = await adapter.createPullRequest({
      sandboxId,
      repoOwner: environment.repoOwner,
      repoName: environment.repoName,
      branch,
      baseBranch: environment.baseBranch,
      title: task.prompt.slice(0, 120),
      body: `Generated by Chloei cloud agent.\n\nTask: ${task.prompt}`,
    })

    await createCloudAgentArtifact({
      userId: input.userId,
      taskId: input.taskId,
      input: {
        kind: "preview",
        label: `Pull request #${String(pr.number)}`,
        url: pr.url,
        metadata: { source: "github_pull_request" },
      },
    })

    // Preview URL is populated asynchronously by the Vercel deployment webhook
    // (POST /api/webhooks/vercel) once the PR deployment finishes.

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: {
        status: "pr_ready",
        prUrl: pr.url,
        summary: `Opened ${pr.url}`,
      },
      phase: "Pull request ready",
    })

    await applyStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "completed" },
      phase: "Completed",
    })
  } catch (error) {
    await failTask({
      userId: input.userId,
      taskId: input.taskId,
      error,
      errorCode: "CLOUD_AGENT_PUSH_FAILED",
    })
  } finally {
    if (sandboxId) {
      await adapter.destroy({ sandboxId }).catch(() => undefined)
    }
  }
}
