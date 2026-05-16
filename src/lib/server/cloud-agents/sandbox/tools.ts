import { tool } from "ai"
import { z } from "zod"

import type {
  CloudAgentSandboxAdapter,
  CloudAgentSandboxCommandResult,
  CloudAgentSandboxDiff,
} from "./types"

// Repo-relative path. Reject absolute paths, any `..` segment, NUL
// bytes, and backslashes. The LLM is the caller, so a repo containing
// adversarial instructions could otherwise prompt-inject the tool
// into reading or writing outside the checkout (e.g. into the host
// container's filesystem). The Vercel adapter also re-validates.
// Bound LLM-controlled commands so a hung lint/test/install can be
// aborted via the adapter's AbortController path instead of stalling
// the Inngest step until the 90-min sandbox timeout. Tests get a
// longer ceiling than ad-hoc commands.
const TOOL_RUN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const TOOL_RUN_TESTS_TIMEOUT_MS = 15 * 60 * 1000

const FILE_PATH_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.split("/").some((segment) => segment === ".." || segment === "."),
    "Path must be a repo-relative path without '..' or '.' segments, leading '/', NUL bytes, or backslashes."
  )
  .describe("Repo-relative file path (no leading slash, no '..' segments).")
const FILE_CONTENT_SCHEMA = z
  .string()
  .max(200_000)
  .describe("Full file contents (writes overwrite the file).")
const COMMAND_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe("Single shell command to run inside the sandbox.")

export interface CloudAgentToolEvent {
  callId: string
  toolName: string
  label: string
  input?: unknown
  output?: unknown
  errorMessage?: string
  // Raw stdout / stderr captured from a sandbox command. The consumer
  // emits one `terminal_output` event per non-empty stream so a command
  // that writes to both is not silently truncated to one stream and a
  // successful command emitting only stderr warnings is not mislabeled
  // as stdout.
  terminal?: {
    stdout: string
    stderr: string
  }
  fileChange?: {
    path: string
    change: "added" | "modified" | "deleted" | "renamed"
  }
  status: "success" | "error"
}

export interface BuildCloudAgentToolsParams {
  adapter: CloudAgentSandboxAdapter
  sandboxId: string
  baseBranch: string
  testCommand?: string
  onCall: (event: {
    callId: string
    toolName: string
    label: string
    input: unknown
  }) => Promise<void>
  onResult: (event: CloudAgentToolEvent) => Promise<void>
}

function summarizeDiff(diff: CloudAgentSandboxDiff): string {
  if (diff.totals.filesChanged === 0) {
    return "No file changes."
  }
  const lines = diff.files
    .slice(0, 10)
    .map(
      (file) =>
        `- ${file.change} ${file.path} (+${String(file.additions)}/-${String(file.deletions)})`
    )
  const truncated =
    diff.files.length > 10
      ? `\n…and ${String(diff.files.length - 10)} more.`
      : ""
  return `${String(diff.totals.filesChanged)} file(s) changed, +${String(diff.totals.additions)}/-${String(diff.totals.deletions)}:\n${lines.join("\n")}${truncated}`
}

function summarizeCommandResult(
  result: CloudAgentSandboxCommandResult
): string {
  const trimmedStdout =
    result.stdout.length > 4_000
      ? `${result.stdout.slice(0, 4_000)}\n…[truncated]`
      : result.stdout
  const trimmedStderr =
    result.stderr.length > 4_000
      ? `${result.stderr.slice(0, 4_000)}\n…[truncated]`
      : result.stderr
  const sections: string[] = [`exit_code=${String(result.exitCode)}`]
  if (trimmedStdout) sections.push(`stdout:\n${trimmedStdout}`)
  if (trimmedStderr) sections.push(`stderr:\n${trimmedStderr}`)
  return sections.join("\n\n")
}

export function buildCloudAgentSandboxTools(
  params: BuildCloudAgentToolsParams
) {
  let toolCallCounter = 0
  const nextCallId = (prefix: string): string => {
    toolCallCounter += 1
    return `${prefix}-${String(toolCallCounter)}`
  }
  const { adapter, sandboxId } = params

  return {
    read_file: tool({
      description:
        "Read the full contents of a file inside the sandbox repo. Use to inspect existing code before editing.",
      inputSchema: z.object({
        path: FILE_PATH_SCHEMA,
      }),
      async execute({ path: filePath }) {
        const callId = nextCallId("read_file")
        const label = `Read ${filePath}`
        await params.onCall({
          callId,
          toolName: "read_file",
          label,
          input: { path: filePath },
        })
        try {
          const result = await adapter.readFile({ sandboxId, path: filePath })
          await params.onResult({
            callId,
            toolName: "read_file",
            label,
            status: "success",
            output: { bytes: result.content.length },
          })
          return result.content
        } catch (error) {
          const message = error instanceof Error ? error.message : "read failed"
          await params.onResult({
            callId,
            toolName: "read_file",
            label,
            status: "error",
            errorMessage: message,
          })
          return `error: ${message}`
        }
      },
    }),

    write_file: tool({
      description:
        "Write (or overwrite) a file in the sandbox repo with the given content. Use after planning your edits; prefer minimal changes.",
      inputSchema: z.object({
        path: FILE_PATH_SCHEMA,
        content: FILE_CONTENT_SCHEMA,
      }),
      async execute({ path: filePath, content }) {
        const callId = nextCallId("write_file")
        const label = `Write ${filePath}`
        await params.onCall({
          callId,
          toolName: "write_file",
          label,
          input: { path: filePath, bytes: content.length },
        })
        try {
          const { wasNew } = await adapter.writeFile({
            sandboxId,
            path: filePath,
            content,
          })
          await params.onResult({
            callId,
            toolName: "write_file",
            label,
            status: "success",
            output: { bytes: content.length },
            fileChange: {
              path: filePath,
              change: wasNew ? "added" : "modified",
            },
          })
          return `wrote ${String(content.length)} bytes to ${filePath}`
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "write failed"
          await params.onResult({
            callId,
            toolName: "write_file",
            label,
            status: "error",
            errorMessage: message,
          })
          return `error: ${message}`
        }
      },
    }),

    run_command: tool({
      description:
        "Run a shell command inside the sandbox. Use for linting, formatting, file listing, or installing extra deps. Network access follows the environment policy.",
      inputSchema: z.object({
        command: COMMAND_SCHEMA,
      }),
      async execute({ command }) {
        const callId = nextCallId("run_command")
        const label = `Run ${command.slice(0, 80)}`
        await params.onCall({
          callId,
          toolName: "run_command",
          label,
          input: { command },
        })
        try {
          const result = await adapter.runCommand({
            sandboxId,
            command,
            timeoutMs: TOOL_RUN_COMMAND_TIMEOUT_MS,
          })
          await params.onResult({
            callId,
            toolName: "run_command",
            label,
            status: result.exitCode === 0 ? "success" : "error",
            output: {
              exitCode: result.exitCode,
              stdoutBytes: result.stdout.length,
              stderrBytes: result.stderr.length,
            },
            terminal: { stdout: result.stdout, stderr: result.stderr },
          })
          return summarizeCommandResult(result)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "command failed"
          await params.onResult({
            callId,
            toolName: "run_command",
            label,
            status: "error",
            errorMessage: message,
          })
          return `error: ${message}`
        }
      },
    }),

    run_tests: tool({
      description:
        "Run the environment's configured test command and return the result. If no test command is configured, returns a notice.",
      inputSchema: z.object({}),
      async execute() {
        const callId = nextCallId("run_tests")
        const label = params.testCommand
          ? `Run tests: ${params.testCommand.slice(0, 80)}`
          : "Run tests"
        await params.onCall({
          callId,
          toolName: "run_tests",
          label,
          input: { command: params.testCommand ?? null },
        })
        if (!params.testCommand) {
          await params.onResult({
            callId,
            toolName: "run_tests",
            label,
            status: "success",
            output: { skipped: true, reason: "no_test_command_configured" },
          })
          return "no test command configured on this environment; skipping"
        }
        try {
          const result = await adapter.runCommand({
            sandboxId,
            command: params.testCommand,
            timeoutMs: TOOL_RUN_TESTS_TIMEOUT_MS,
          })
          await params.onResult({
            callId,
            toolName: "run_tests",
            label,
            status: result.exitCode === 0 ? "success" : "error",
            output: { exitCode: result.exitCode },
            terminal: { stdout: result.stdout, stderr: result.stderr },
          })
          return summarizeCommandResult(result)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "tests failed"
          await params.onResult({
            callId,
            toolName: "run_tests",
            label,
            status: "error",
            errorMessage: message,
          })
          return `error: ${message}`
        }
      },
    }),

    get_diff: tool({
      description:
        "Return a summary of unstaged changes the agent has made in this sandbox vs. the base branch. Use right before finishing to confirm scope.",
      inputSchema: z.object({}),
      async execute() {
        const callId = nextCallId("get_diff")
        const label = "Inspect diff"
        await params.onCall({
          callId,
          toolName: "get_diff",
          label,
          input: {},
        })
        try {
          const diff = await adapter.getDiff({
            sandboxId,
            baseBranch: params.baseBranch,
          })
          await params.onResult({
            callId,
            toolName: "get_diff",
            label,
            status: "success",
            output: diff.totals,
          })
          return summarizeDiff(diff)
        } catch (error) {
          const message = error instanceof Error ? error.message : "diff failed"
          await params.onResult({
            callId,
            toolName: "get_diff",
            label,
            status: "error",
            errorMessage: message,
          })
          return `error: ${message}`
        }
      },
    }),

    summarize_changes: tool({
      description:
        "Mark the task as ready for human approval. Provide a short PR-style summary; the runtime will request approval to push and open a pull request.",
      inputSchema: z.object({
        summary: z
          .string()
          .trim()
          .min(1)
          .max(4_000)
          .describe("1-3 sentence PR-ready summary of what changed and why."),
      }),
      async execute({ summary }) {
        const callId = nextCallId("summarize_changes")
        const label = "Summarize for review"
        await params.onCall({
          callId,
          toolName: "summarize_changes",
          label,
          input: { summary },
        })
        await params.onResult({
          callId,
          toolName: "summarize_changes",
          label,
          status: "success",
          input: { summary },
          output: { summary },
        })
        return `summary recorded: ${summary}`
      },
    }),
  }
}
