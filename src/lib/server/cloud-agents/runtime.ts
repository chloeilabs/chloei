import { createLogger } from "@/lib/logger"
import {
  type CloudAgentApprovalAction,
  deriveCloudAgentTaskBranchName,
} from "@/lib/shared/cloud-agents"

import { requestCloudAgentApproval } from "./approvals"
import { createCloudAgentArtifact } from "./artifacts"
import { startCloudAgentTaskRunWithLlm } from "./llm-runtime"
import {
  applyCloudAgentStatus,
  applyCloudAgentStatusIfFrom,
  emitCloudAgentEvent,
  emitTerminalOutput,
  failCloudAgentTask,
  getCloudAgentEnvironmentOrFail,
} from "./runtime-helpers"
import { fakeCloudAgentSandboxAdapter } from "./sandbox/fake"
import type { CloudAgentSandboxAdapter } from "./sandbox/types"
import {
  isVercelSandboxConfigured,
  vercelCloudAgentSandboxAdapter,
} from "./sandbox/vercel"
import { getCloudAgentTask, updateCloudAgentTask } from "./tasks"

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

interface RunInput {
  userId: string
  taskId: string
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

  const environment = await getCloudAgentEnvironmentOrFail({
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
    // Atomically claim the task. Two runners can race past the
    // `task.status !== "queued"` read above (e.g. a duplicate
    // Inngest delivery, or the dev-mode inline fallback firing
    // alongside a real worker). The conditional UPDATE ensures only
    // one runner transitions queued → provisioning; the loser sees
    // null and exits before provisioning a second sandbox.
    const claimed = await applyCloudAgentStatusIfFrom({
      userId: input.userId,
      taskId: input.taskId,
      allowedFromStatuses: ["queued"],
      update: { status: "provisioning" },
      phase: "Provisioning sandbox",
    })
    if (!claimed) {
      logger.info(
        "Skipping run: task was claimed by another runner or moved out of queued.",
        input
      )
      return
    }
    const provisioned = await adapter.provision({
      userId: input.userId,
      taskId: input.taskId,
      repoOwner: environment.repoOwner,
      repoName: environment.repoName,
      baseBranch: environment.baseBranch,
      sandboxRuntime: environment.sandboxRuntime,
      networkPolicy: environment.networkPolicy,
    })
    sandboxId = provisioned.sandboxId
    await updateCloudAgentTask(input.userId, input.taskId, { sandboxId })

    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "setting_up" },
      phase: "Running setup command",
    })
    if (environment.setupCommand) {
      const setupCallId = `setup-${sandboxId}`
      await emitCloudAgentEvent({
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
      await emitTerminalOutput({
        userId: input.userId,
        taskId: input.taskId,
        stdout: setupResult.stdout,
        stderr: setupResult.stderr,
        callId: setupCallId,
      })
      await emitCloudAgentEvent({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_result",
          callId: setupCallId,
          status: setupResult.exitCode === 0 ? "success" : "error",
        },
      })
      if (setupResult.exitCode !== 0) {
        throw new Error(
          `Setup failed (exit ${String(setupResult.exitCode)}). Cloud agent did not enter the planning phase.`
        )
      }
    }

    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "planning" },
      phase: "Planning changes",
    })
    await emitCloudAgentEvent({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "text_delta",
        text: `Plan for "${task.prompt.slice(0, 120)}":\n\n1. Inspect repository layout.\n2. Apply requested edits.\n3. Run tests and summarize.\n`,
      },
    })

    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "editing" },
      phase: "Editing files",
    })
    const targetPath = "CLOUD_AGENT_NOTE.md"
    const fileBody = `# Cloud agent note\n\nTask: ${task.prompt}\n\nGenerated by Chloei cloud agent (${mode} runtime).\n`
    const editCallId = `edit-${sandboxId}`
    await emitCloudAgentEvent({
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
    await emitCloudAgentEvent({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "file_change",
        path: targetPath,
        change: "added",
      },
    })
    await emitCloudAgentEvent({
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
    await emitCloudAgentEvent({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "diff_update",
        filesChanged: diff.totals.filesChanged,
        additions: diff.totals.additions,
        deletions: diff.totals.deletions,
      },
    })

    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "testing" },
      phase: "Running tests",
    })
    if (environment.testCommand) {
      const testCallId = `test-${sandboxId}`
      await emitCloudAgentEvent({
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
      await emitTerminalOutput({
        userId: input.userId,
        taskId: input.taskId,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
        callId: testCallId,
      })
      await emitCloudAgentEvent({
        userId: input.userId,
        taskId: input.taskId,
        event: {
          kind: "tool_result",
          callId: testCallId,
          status: testResult.exitCode === 0 ? "success" : "error",
        },
      })
      if (testResult.exitCode !== 0) {
        await failCloudAgentTask({
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

    await applyCloudAgentStatus({
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
    await emitCloudAgentEvent({
      userId: input.userId,
      taskId: input.taskId,
      event,
    })
  } catch (error) {
    try {
      await failCloudAgentTask({
        userId: input.userId,
        taskId: input.taskId,
        error,
        errorCode: "CLOUD_AGENT_RUN_FAILED",
      })
    } finally {
      if (sandboxId) {
        await adapter.destroy({ sandboxId }).catch(() => undefined)
      }
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
    // Conditional cancel: the initial status read above can race with
    // a concurrent user cancel from the dashboard. Only flip to
    // `cancelled` if the row is still in `waiting_for_approval`;
    // otherwise the user already moved it and we should leave it
    // alone. Sandbox destroy still runs in both cases — it's a
    // best-effort cleanup of the resource the prior runtime owned.
    const transitioned = await applyCloudAgentStatusIfFrom({
      userId: input.userId,
      taskId: input.taskId,
      allowedFromStatuses: ["waiting_for_approval"],
      update: {
        status: "cancelled",
        summary: input.note ?? "Push denied.",
      },
      phase: "Push denied",
    })
    if (!transitioned) {
      logger.info(
        "Skipping deny: task moved out of waiting_for_approval before deny landed.",
        input
      )
    }
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

  const environment = await getCloudAgentEnvironmentOrFail({
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
    await failCloudAgentTask({
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
    // Conditional transition guards each push-phase write so a
    // concurrent cancel can't be silently overwritten. The cancel
    // route uses an atomic UPDATE in the reverse direction; this is
    // the matching guard for `cancelled` → push completion.
    const pushing = await applyCloudAgentStatusIfFrom({
      userId: input.userId,
      taskId: input.taskId,
      allowedFromStatuses: ["waiting_for_approval"],
      update: { status: "pushing" },
      phase: "Pushing branch",
    })
    if (!pushing) {
      logger.info(
        "Skipping push: task is no longer waiting_for_approval (likely cancelled).",
        input
      )
      return
    }
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

    // If the user cancelled while we were pushing, the PR has
    // already shipped on GitHub but we honor the cancel by NOT
    // flipping the row out of `cancelled` into pr_ready/completed.
    // The cancel route's atomic UPDATE wins; the user can see the
    // PR on GitHub directly.
    const prReady = await applyCloudAgentStatusIfFrom({
      userId: input.userId,
      taskId: input.taskId,
      allowedFromStatuses: ["pushing"],
      update: {
        status: "pr_ready",
        prUrl: pr.url,
        summary: `Opened ${pr.url}`,
      },
      phase: "Pull request ready",
    })
    if (!prReady) {
      logger.warn(
        "PR shipped but task is no longer in `pushing` (likely user cancel). Not overwriting terminal status.",
        { ...input, prUrl: pr.url }
      )
      return
    }

    await applyCloudAgentStatusIfFrom({
      userId: input.userId,
      taskId: input.taskId,
      allowedFromStatuses: ["pr_ready"],
      update: { status: "completed" },
      phase: "Completed",
    })
  } catch (error) {
    await failCloudAgentTask({
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
