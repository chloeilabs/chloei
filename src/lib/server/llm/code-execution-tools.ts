import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tool } from "ai"
import { z } from "zod"

import { asRecord } from "@/lib/cast"
import type { ToolName } from "@/lib/shared"

const CODE_EXECUTION_TOOL_NAME = "code_execution" as const
const CODE_EXECUTION_LABEL = "Running code" as const

const CODE_EXECUTION_DEFAULT_TIMEOUT_MS = 4_000
const CODE_EXECUTION_MAX_TIMEOUT_MS = 8_000
const CODE_EXECUTION_MAX_CODE_CHARS = 12_000
const CODE_EXECUTION_MAX_OUTPUT_CHARS = 12_000
const PYTHON3_COMMAND = process.env.PYTHON3_PATH?.trim() ?? "python3"

type CodeExecutionToolName = Extract<ToolName, typeof CODE_EXECUTION_TOOL_NAME>
type CodeExecutionLanguage = "javascript" | "python"

interface CodeExecutionToolArgs {
  language: CodeExecutionLanguage
  code: string
  timeoutMs: number
}

interface CodeExecutionToolOutput {
  language: CodeExecutionLanguage
  stdout: string
  stderr: string
  combinedOutput: string
  exitCode: number
  durationMs: number
  truncated: boolean
}

interface CodeExecutionToolErrorPayload extends Partial<CodeExecutionToolOutput> {
  message: string
  code?: string
  timedOut?: boolean
}

interface CodeExecutionToolResultPayload {
  output?: CodeExecutionToolOutput
  error?: CodeExecutionToolErrorPayload
}

interface AiSdkCodeExecutionToolCallMetadata {
  callId: string
  toolName: CodeExecutionToolName
  label: string
}

interface AiSdkCodeExecutionToolResultMetadata {
  callId: string
  toolName: CodeExecutionToolName
  status: "success" | "error"
  sources: []
}

const codeExecutionInputSchema = z.object({
  language: z.enum(["javascript", "python"]).default("javascript"),
  code: z.string().trim().min(1).max(CODE_EXECUTION_MAX_CODE_CHARS),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(CODE_EXECUTION_MAX_TIMEOUT_MS)
    .optional(),
})

const JAVASCRIPT_FORBIDDEN_PATTERNS = [
  { pattern: /\b(?:require|import)\b/, label: "module loading" },
  { pattern: /\bprocess\b/, label: "process access" },
  {
    pattern: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/,
    label: "network access",
  },
  {
    pattern: /\b(?:fs|child_process|http|https|net|tls|dns|os)\b/,
    label: "system modules",
  },
  { pattern: /\b(?:Deno|Bun|Worker)\b/, label: "runtime escape APIs" },
] as const

const PYTHON_FORBIDDEN_PATTERNS = [
  {
    pattern: /\b(?:open|exec|eval|compile|__import__)\s*\(/,
    label: "dynamic or filesystem execution",
  },
  {
    pattern:
      /\b(?:subprocess|socket|requests|urllib|http|pathlib|os|sys|shutil|tempfile|ctypes|multiprocessing|threading|asyncio|builtins)\b/,
    label: "system, filesystem, or network modules",
  },
] as const

const PYTHON_ALLOWED_IMPORTS = new Set([
  "array",
  "bisect",
  "collections",
  "dataclasses",
  "decimal",
  "fractions",
  "functools",
  "heapq",
  "itertools",
  "json",
  "math",
  "operator",
  "random",
  "re",
  "statistics",
  "string",
  "typing",
])

function clampTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CODE_EXECUTION_DEFAULT_TIMEOUT_MS
  }

  return Math.max(
    100,
    Math.min(CODE_EXECUTION_MAX_TIMEOUT_MS, Math.trunc(value))
  )
}

function normalizeLanguage(value: unknown): CodeExecutionLanguage {
  return value === "python" ? "python" : "javascript"
}

function resolveLabel(language: CodeExecutionLanguage | undefined): string {
  if (language === "python") {
    return "Running Python"
  }

  if (language === "javascript") {
    return "Running JavaScript"
  }

  return CODE_EXECUTION_LABEL
}

function buildCombinedOutput(stdout: string, stderr: string): string {
  const sections = [
    stdout.trim() ? `stdout:\n${stdout.trimEnd()}` : null,
    stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : null,
  ].filter((section): section is string => section !== null)

  return sections.join("\n\n").trim()
}

function appendWithLimit(
  current: string,
  chunk: Buffer | string
): {
  next: string
  truncated: boolean
} {
  const nextChunk = chunk.toString("utf8")
  if (current.length >= CODE_EXECUTION_MAX_OUTPUT_CHARS) {
    return { next: current, truncated: true }
  }

  const remaining = CODE_EXECUTION_MAX_OUTPUT_CHARS - current.length
  const next = current + nextChunk.slice(0, remaining)
  return {
    next,
    truncated: nextChunk.length > remaining,
  }
}

function validatePythonImports(code: string): string | null {
  const lines = code.split(/\r?\n/g)

  for (const line of lines) {
    const importMatch = /^\s*import\s+(.+?)\s*$/.exec(line)
    if (importMatch?.[1]) {
      const modules = importMatch[1]
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .split(/\s+as\s+/i)[0]
            ?.trim()
        )
        .filter((entry): entry is string => Boolean(entry))

      for (const moduleName of modules) {
        const rootModule = moduleName.split(".")[0]
        if (rootModule && !PYTHON_ALLOWED_IMPORTS.has(rootModule)) {
          return `Python imports are limited to safe computation modules. Blocked import: ${rootModule}.`
        }
      }
    }

    const fromMatch = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/.exec(line)
    const rootModule = fromMatch?.[1]?.split(".")[0]
    if (rootModule && !PYTHON_ALLOWED_IMPORTS.has(rootModule)) {
      return `Python imports are limited to safe computation modules. Blocked import: ${rootModule}.`
    }
  }

  return null
}

function validateCodeSafety(args: CodeExecutionToolArgs): string | null {
  if (args.language === "javascript") {
    for (const rule of JAVASCRIPT_FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(args.code)) {
        return `JavaScript code execution is limited to self-contained computation and cannot use ${rule.label}.`
      }
    }

    return null
  }

  for (const rule of PYTHON_FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(args.code)) {
      return `Python code execution is limited to self-contained computation and cannot use ${rule.label}.`
    }
  }

  return validatePythonImports(args.code)
}

async function runProcess(args: {
  command: string
  commandArgs: string[]
  timeoutMs: number
}): Promise<CodeExecutionToolResultPayload> {
  const startedAt = Date.now()
  const tempDir = await mkdtemp(path.join(tmpdir(), "yurie-code-exec-"))

  let stdout = ""
  let stderr = ""
  let truncated = false
  let timedOut = false

  try {
    return await new Promise<CodeExecutionToolResultPayload>((resolve) => {
      let settled = false
      const child = spawn(args.command, args.commandArgs, {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          PATH: process.env.PATH ?? "",
          PYTHONNOUSERSITE: "1",
          TMPDIR: tempDir,
          TMP: tempDir,
          TEMP: tempDir,
          NODE_NO_WARNINGS: "1",
        },
        stdio: "pipe",
      })

      const finish = (payload: CodeExecutionToolResultPayload) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeoutId)
        resolve(payload)
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        const result = appendWithLimit(stdout, chunk)
        stdout = result.next
        truncated ||= result.truncated
      })

      child.stderr.on("data", (chunk: Buffer | string) => {
        const result = appendWithLimit(stderr, chunk)
        stderr = result.next
        truncated ||= result.truncated
      })

      child.on("error", (error: Error) => {
        finish({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Code execution failed to start.",
            code: "SPAWN_ERROR",
          },
        })
      })

      child.on("close", (exitCode: number | null) => {
        const durationMs = Date.now() - startedAt
        const combinedOutput = buildCombinedOutput(stdout, stderr)

        if (timedOut) {
          finish({
            error: {
              message: `Code execution timed out after ${String(args.timeoutMs)}ms.`,
              code: "TIMEOUT",
              timedOut: true,
              stdout,
              stderr,
              combinedOutput,
              durationMs,
              truncated,
            },
          })
          return
        }

        const normalizedExitCode = typeof exitCode === "number" ? exitCode : 1
        if (normalizedExitCode !== 0) {
          finish({
            error: {
              message: `Code execution exited with status ${String(normalizedExitCode)}.`,
              code: "EXIT_NON_ZERO",
              exitCode: normalizedExitCode,
              stdout,
              stderr,
              combinedOutput,
              durationMs,
              truncated,
            },
          })
          return
        }

        finish({
          output: {
            language:
              args.command === PYTHON3_COMMAND ? "python" : "javascript",
            exitCode: normalizedExitCode,
            stdout,
            stderr,
            combinedOutput,
            durationMs,
            truncated,
          },
        })
      })

      const timeoutId = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, args.timeoutMs)
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function executeCode(
  args: CodeExecutionToolArgs
): Promise<CodeExecutionToolResultPayload> {
  const safetyError = validateCodeSafety(args)
  if (safetyError) {
    return {
      error: {
        message: safetyError,
        code: "BLOCKED_PATTERN",
      },
    }
  }

  if (args.language === "python") {
    const result = await runProcess({
      command: PYTHON3_COMMAND,
      commandArgs: ["-I", "-c", args.code],
      timeoutMs: args.timeoutMs,
    })

    if (result.output) {
      result.output.language = "python"
    }

    if (result.error) {
      result.error.language = "python"
    }

    return result
  }

  const result = await runProcess({
    command: process.execPath,
    commandArgs: ["--input-type=module", "--eval", args.code],
    timeoutMs: args.timeoutMs,
  })

  if (result.output) {
    result.output.language = "javascript"
  }

  if (result.error) {
    result.error.language = "javascript"
  }

  return result
}

function parseAiSdkResultPayload(
  value: unknown
): CodeExecutionToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  return {
    ...(asRecord(normalized.output)
      ? { output: normalized.output as CodeExecutionToolOutput }
      : {}),
    ...(asRecord(normalized.error)
      ? { error: normalized.error as CodeExecutionToolErrorPayload }
      : {}),
  }
}

function getAiSdkLabel(value: unknown): string {
  const record = asRecord(value)
  return resolveLabel(normalizeLanguage(record?.language))
}

export function isAiSdkCodeExecutionToolName(
  value: unknown
): value is CodeExecutionToolName {
  return value === CODE_EXECUTION_TOOL_NAME
}

export function createAiSdkCodeExecutionTools() {
  return {
    code_execution: tool({
      description:
        "Execute small self-contained JavaScript or Python snippets for arithmetic, logic checks, data transformations, or quick validation. This tool cannot access the network, filesystem, or subprocesses.",
      inputSchema: codeExecutionInputSchema,
      execute: async (input) =>
        executeCode({
          language: input.language,
          code: input.code,
          timeoutMs: clampTimeoutMs(input.timeoutMs),
        }),
    }),
  }
}

export function getAiSdkCodeExecutionToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkCodeExecutionToolCallMetadata | null {
  if (part?.toolName !== CODE_EXECUTION_TOOL_NAME) {
    return null
  }

  return {
    callId: part.toolCallId,
    toolName: CODE_EXECUTION_TOOL_NAME,
    label: getAiSdkLabel(part.input),
  }
}

export function getAiSdkCodeExecutionToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkCodeExecutionToolResultMetadata | null {
  if (part?.toolName !== CODE_EXECUTION_TOOL_NAME) {
    return null
  }

  const payload = parseAiSdkResultPayload(part.output)
  return {
    callId: part.toolCallId,
    toolName: CODE_EXECUTION_TOOL_NAME,
    status: payload?.error || !payload?.output ? "error" : "success",
    sources: [],
  }
}
