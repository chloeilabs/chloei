import { createGateway } from "@ai-sdk/gateway"
import { generateText, stepCountIs, type ToolSet } from "ai"

import { createLogger } from "@/lib/logger"
import {
  type CloudAgentApprovalAction,
  type CloudAgentEnvironment,
  deriveCloudAgentTaskBranchName,
} from "@/lib/shared/cloud-agents"

import { requestCloudAgentApproval } from "./approvals"
import { getCloudAgentEnvironment } from "./environments"
import {
  applyCloudAgentStatus,
  emitCloudAgentEvent,
  emitTerminalOutput,
  failCloudAgentTask,
} from "./runtime-helpers"
import {
  buildCloudAgentSandboxTools,
  type CloudAgentToolEvent,
} from "./sandbox/tools"
import type { CloudAgentSandboxAdapter } from "./sandbox/types"
import { getCloudAgentTask, updateCloudAgentTask } from "./tasks"

const logger = createLogger("cloud-agent-llm-runtime")

const DEFAULT_LLM_MODEL_ID = "moonshotai/kimi-k2.6"
const DEFAULT_MAX_TOOL_STEPS = 80
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000

function resolveLlmModelId(): string {
  const explicit = process.env.CLOUD_AGENT_LLM_MODEL?.trim()
  return explicit && explicit.length > 0 ? explicit : DEFAULT_LLM_MODEL_ID
}

function resolveMaxToolSteps(): number {
  const raw = process.env.AGENT_CLOUD_AGENT_TOOL_MAX_STEPS?.trim()
  if (!raw) return DEFAULT_MAX_TOOL_STEPS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_STEPS
}

function buildSystemPrompt(environment: CloudAgentEnvironment): string {
  const lines = [
    "You are Chloei's cloud coding agent operating in an isolated sandbox cloned from a Git repository.",
    `Repo: ${environment.repoOwner}/${environment.repoName} (base branch: ${environment.baseBranch}).`,
    "Make the smallest correct change that fulfills the user request. Inspect before editing. Run tests if a test command is configured. Avoid extraneous edits or scope creep.",
    "Tools available: read_file, write_file, run_command, run_tests, get_diff, summarize_changes. Use summarize_changes when you are done so the runtime can request approval to push.",
    "Never commit secrets, credentials, or generated lockfiles unrelated to your change.",
  ]
  if (environment.networkPolicy.mode === "off") {
    lines.push(
      "Network access is OFF during the agent phase — do not try to download dependencies or contact external services."
    )
  } else if (environment.networkPolicy.mode === "allowlist") {
    lines.push(
      `Network access is restricted to an allowlist (${(environment.networkPolicy.allowlist ?? []).join(", ") || "empty"}).`
    )
  }
  return lines.join("\n\n")
}

interface RunLlmInput {
  userId: string
  taskId: string
  adapter: CloudAgentSandboxAdapter
  aiGatewayApiKey: string
  signal?: AbortSignal
}

export async function startCloudAgentTaskRunWithLlm(
  input: RunLlmInput
): Promise<void> {
  const task = await getCloudAgentTask(input.userId, input.taskId)
  if (!task) {
    logger.warn("Cloud agent task disappeared before LLM runtime started.", {
      userId: input.userId,
      taskId: input.taskId,
    })
    return
  }
  if (task.status !== "queued") {
    logger.info("Cloud agent task not in queued state; skipping LLM run.", {
      userId: input.userId,
      taskId: input.taskId,
      status: task.status,
    })
    return
  }

  const environment = await getCloudAgentEnvironment(
    input.userId,
    task.environmentId
  )
  if (!environment) {
    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "failed", error: "Environment not found." },
    })
    await emitCloudAgentEvent({
      userId: input.userId,
      taskId: input.taskId,
      event: {
        kind: "error",
        message: "Environment not found for this task.",
        errorCode: "CLOUD_AGENT_ENVIRONMENT_MISSING",
        retryable: false,
      },
    })
    return
  }

  let sandboxId: string | null = null
  const summaryRef = { value: null as string | null }

  try {
    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "provisioning" },
      phase: "Provisioning sandbox",
    })
    const provisioned = await input.adapter.provision({
      userId: input.userId,
      taskId: input.taskId,
      repoOwner: environment.repoOwner,
      repoName: environment.repoName,
      baseBranch: environment.baseBranch,
      sandboxRuntime: environment.sandboxRuntime,
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
      const setupResult = await input.adapter.runSetup({
        sandboxId,
        command: environment.setupCommand,
      })
      await emitTerminalOutput({
        userId: input.userId,
        taskId: input.taskId,
        stdout: setupResult.stdout,
        stderr: setupResult.stderr,
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
      phase: "LLM planning and editing",
    })

    const gateway = createGateway({ apiKey: input.aiGatewayApiKey })
    const tools: ToolSet = buildCloudAgentSandboxTools({
      adapter: input.adapter,
      sandboxId,
      baseBranch: environment.baseBranch,
      ...(environment.testCommand
        ? { testCommand: environment.testCommand }
        : {}),
      onCall: async (event) => {
        await emitCloudAgentEvent({
          userId: input.userId,
          taskId: input.taskId,
          event: {
            kind: "tool_call",
            callId: event.callId,
            toolName: event.toolName,
            label: event.label,
          },
        })
      },
      onResult: async (event: CloudAgentToolEvent) => {
        if (event.terminal) {
          await emitTerminalOutput({
            userId: input.userId,
            taskId: input.taskId,
            stdout: event.terminal.stdout,
            stderr: event.terminal.stderr,
            callId: event.callId,
          })
        }
        if (event.fileChange) {
          await emitCloudAgentEvent({
            userId: input.userId,
            taskId: input.taskId,
            event: {
              kind: "file_change",
              path: event.fileChange.path,
              change: event.fileChange.change,
            },
          })
        }
        await emitCloudAgentEvent({
          userId: input.userId,
          taskId: input.taskId,
          event: {
            kind: "tool_result",
            callId: event.callId,
            status: event.status,
            ...(event.errorMessage ? { error: event.errorMessage } : {}),
          },
        })
        if (
          event.toolName === "summarize_changes" &&
          event.status === "success"
        ) {
          const summary = (event.input as { summary?: string } | undefined)
            ?.summary
          if (summary) {
            summaryRef.value = summary
          }
        }
      },
    })

    const modelId = resolveLlmModelId()
    const maxSteps = resolveMaxToolSteps()
    const result = await generateText({
      model: gateway(modelId),
      system: buildSystemPrompt(environment),
      prompt: task.prompt,
      tools,
      stopWhen: stepCountIs(maxSteps),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      abortSignal: input.signal,
    })

    if (result.text.trim()) {
      await emitCloudAgentEvent({
        userId: input.userId,
        taskId: input.taskId,
        event: { kind: "text_delta", text: result.text.trim() },
      })
    }

    const diff = await input.adapter.getDiff({
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

    if (environment.testCommand) {
      await applyCloudAgentStatus({
        userId: input.userId,
        taskId: input.taskId,
        update: { status: "testing" },
        phase: "Running tests",
      })
      const testResult = await input.adapter.runCommand({
        sandboxId,
        command: environment.testCommand,
      })
      await emitTerminalOutput({
        userId: input.userId,
        taskId: input.taskId,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
      })
      if (testResult.exitCode !== 0) {
        await failCloudAgentTask({
          userId: input.userId,
          taskId: input.taskId,
          error: new Error(
            `Tests failed (exit ${String(testResult.exitCode)}). Cloud agent edits were not pushed.`
          ),
          errorCode: "CLOUD_AGENT_TESTS_FAILED",
          loggerScope: "cloud-agent-llm-runtime",
        })
        if (sandboxId) {
          await input.adapter.destroy({ sandboxId }).catch(() => undefined)
        }
        return
      }
    }

    const branch = deriveCloudAgentTaskBranchName({
      taskId: input.taskId,
      slug: task.prompt,
    })
    const fallbackSummary =
      result.text.split("\n").slice(0, 3).join(" ").trim() || task.prompt
    const summary = summaryRef.value ?? fallbackSummary
    // Single update: write branch + summary AND transition to
    // waiting_for_approval atomically so continueCloudAgentTaskAfterApproval
    // always sees the persisted branch the user approved against (matches
    // the scripted runtime's pattern in runtime.ts).
    await applyCloudAgentStatus({
      userId: input.userId,
      taskId: input.taskId,
      update: { status: "waiting_for_approval", branch, summary },
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
        errorCode: "CLOUD_AGENT_LLM_RUN_FAILED",
        loggerScope: "cloud-agent-llm-runtime",
      })
    } finally {
      if (sandboxId) {
        await input.adapter.destroy({ sandboxId }).catch(() => undefined)
      }
    }
  }
}
