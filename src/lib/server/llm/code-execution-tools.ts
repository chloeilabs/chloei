import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tool } from "ai"
import { z } from "zod"

import { asRecord } from "@/lib/cast"
import {
  AGENT_CODE_EXECUTION_BACKEND,
  AGENT_CODE_EXECUTION_PYTHON_VENV_PATH,
} from "@/lib/server/agent-runtime-config"
import type { ToolName } from "@/lib/shared"

const CODE_EXECUTION_TOOL_NAME = "code_execution" as const
const CODE_EXECUTION_LABEL = "Running code" as const

// Finance/eval prompts run pandas/openpyxl-style calculations and spreadsheet
// artifact writes, which need a longer cap than lightweight chat snippets.
const CODE_EXECUTION_DEFAULT_TIMEOUT_MS = 10_000
const CODE_EXECUTION_MAX_TIMEOUT_MS = 60_000
const CODE_EXECUTION_MAX_CODE_CHARS = 12_000
const CODE_EXECUTION_MAX_OUTPUT_CHARS = 12_000
const PYTHON3_COMMAND = process.env.PYTHON3_PATH?.trim() ?? "python3"

type CodeExecutionToolName = Extract<ToolName, typeof CODE_EXECUTION_TOOL_NAME>
type CodeExecutionLanguage = "javascript" | "python"
export type CodeExecutionBackend = "restricted" | "finance"
type CodeExecutionWorkspaceMode = "ephemeral" | "preserve"

interface CodeExecutionToolArgs {
  language: CodeExecutionLanguage
  code: string
  timeoutMs: number
  backend: CodeExecutionBackend
  workspaceMode: CodeExecutionWorkspaceMode
  workspaceRoot?: string
  inputFiles?: CodeExecutionInputFile[]
}

interface CodeExecutionInputFile {
  sourcePath: string
  relativePath: string
}

interface CodeExecutionArtifact {
  path: string
  sizeBytes: number
}

interface CodeExecutionToolOutput {
  language: CodeExecutionLanguage
  stdout: string
  stderr: string
  combinedOutput: string
  exitCode: number
  durationMs: number
  truncated: boolean
  backend: CodeExecutionBackend
  artifactManifest: CodeExecutionArtifact[]
  artifactDirectory?: string
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
  operation?: string
  provider?: string
}

interface AiSdkCodeExecutionToolResultMetadata {
  callId: string
  toolName: CodeExecutionToolName
  status: "success" | "error"
  sources: []
  operation?: string
  provider?: string
  durationMs?: number
  errorCode?: string
  retryable?: boolean
}

interface CreateAiSdkCodeExecutionToolsOptions {
  backend?: CodeExecutionBackend
  workspaceMode?: CodeExecutionWorkspaceMode
  workspaceRoot?: string
  inputFiles?: CodeExecutionInputFile[]
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
  "calendar",
  "collections",
  "dataclasses",
  "datetime",
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
  "time",
  "typing",
])

const PYTHON_FINANCE_ALLOWED_IMPORTS = new Set([
  ...PYTHON_ALLOWED_IMPORTS,
  "dateutil",
  "matplotlib",
  "mpl_toolkits",
  "numpy",
  "openpyxl",
  "pandas",
  "scipy",
  "statsmodels",
  "xlsxwriter",
  "zipfile",
])

const PYTHON_STRING_LITERAL_PATTERN =
  /(?:^|[^A-Za-z0-9_])(?:[rRuUbBfF]{0,3})(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1/g

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

function normalizeBackend(value: unknown): CodeExecutionBackend {
  return value === "finance" ? "finance" : "restricted"
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

function resolvePythonCommand(backend: CodeExecutionBackend): string {
  const venvPath =
    backend === "finance" ? AGENT_CODE_EXECUTION_PYTHON_VENV_PATH : undefined
  if (!venvPath) {
    return PYTHON3_COMMAND
  }

  const baseName = path.basename(venvPath)
  if (baseName === "python" || baseName === "python3") {
    return venvPath
  }

  return path.join(venvPath, "bin", "python")
}

function inferLanguageFromCommand(command: string): CodeExecutionLanguage {
  const baseName = path.basename(command).toLowerCase()
  return baseName === "python" || baseName === "python3"
    ? "python"
    : "javascript"
}

function isUnsafeWorkspacePathLiteral(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/")
  if (!normalized) {
    return false
  }

  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("file:") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  )
}

function validatePathStringLiterals(code: string): string | null {
  for (const match of code.matchAll(PYTHON_STRING_LITERAL_PATTERN)) {
    const literal = match[2] ?? ""
    if (isUnsafeWorkspacePathLiteral(literal)) {
      return "Python finance code execution can only access relative workspace paths without parent-directory traversal."
    }
  }

  return null
}

function buildPythonSandboxedCode(
  code: string,
  workspaceDir: string,
  tempDir: string
): string {
  const allowedRoots = JSON.stringify([workspaceDir, tempDir])

  return `
def __chloei_install_sandbox():
    import builtins as sandbox_builtins
    import io as sandbox_io
    import os as sandbox_os
    import pathlib as sandbox_pathlib

    allowed_roots = tuple(
        sandbox_os.path.realpath(path) for path in ${allowedRoots}
    )
    original_open = sandbox_builtins.open
    original_io_open = sandbox_io.open
    original_os_open = sandbox_os.open
    original_path_open = sandbox_pathlib.Path.open

    def validate_path(path_value):
        if isinstance(path_value, int):
            return path_value
        try:
            raw_path = sandbox_os.fspath(path_value)
        except TypeError:
            return path_value
        if isinstance(raw_path, bytes):
            raw_path = sandbox_os.fsdecode(raw_path)
        if not isinstance(raw_path, str):
            return path_value
        if raw_path.startswith("file:"):
            raise PermissionError("Code execution cannot access file URLs.")
        candidate = raw_path if sandbox_os.path.isabs(raw_path) else sandbox_os.path.join(sandbox_os.getcwd(), raw_path)
        real_path = sandbox_os.path.realpath(candidate)
        for root in allowed_roots:
            if real_path == root or real_path.startswith(root + sandbox_os.sep):
                return path_value
        raise PermissionError("Code execution can only access files inside the workspace.")

    def sandbox_open(path_value, *args, **kwargs):
        return original_open(validate_path(path_value), *args, **kwargs)

    def sandbox_io_open(path_value, *args, **kwargs):
        return original_io_open(validate_path(path_value), *args, **kwargs)

    def sandbox_os_open(path_value, *args, **kwargs):
        return original_os_open(validate_path(path_value), *args, **kwargs)

    def sandbox_path_open(self, *args, **kwargs):
        validate_path(self)
        return original_path_open(self, *args, **kwargs)

    sandbox_builtins.open = sandbox_open
    sandbox_io.open = sandbox_io_open
    sandbox_os.open = sandbox_os_open
    sandbox_pathlib.Path.open = sandbox_path_open

__chloei_install_sandbox()
del __chloei_install_sandbox

${code}
`.trimStart()
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

async function collectArtifactManifest(
  rootDir: string,
  excludedPaths: ReadonlySet<string> = new Set()
): Promise<CodeExecutionArtifact[]> {
  const artifacts: CodeExecutionArtifact[] = []

  async function walk(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => []
    )

    for (const entry of entries) {
      if (artifacts.length >= 50 || entry.name === "__pycache__") {
        continue
      }

      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const fileStats = await stat(fullPath).catch(() => null)
      if (!fileStats) {
        continue
      }

      const relativePath = path.relative(rootDir, fullPath)
      if (excludedPaths.has(relativePath)) {
        continue
      }

      artifacts.push({
        path: relativePath,
        sizeBytes: fileStats.size,
      })
    }
  }

  await walk(rootDir)
  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

function normalizeInputFileRelativePath(value: string): string | null {
  const normalized = path.normalize(value.trim())
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.split(path.sep).includes("..")
  ) {
    return null
  }

  return normalized
}

async function copyInputFiles(
  workspaceDir: string,
  inputFiles: CodeExecutionInputFile[] | undefined
): Promise<Set<string>> {
  const copied = new Set<string>()
  if (!inputFiles?.length) {
    return copied
  }

  for (const inputFile of inputFiles) {
    const relativePath = normalizeInputFileRelativePath(inputFile.relativePath)
    if (!relativePath) {
      continue
    }

    const destination = path.join(workspaceDir, relativePath)
    copied.add(relativePath)
    const destinationStats = await stat(destination).catch(() => null)
    if (destinationStats) {
      continue
    }

    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(inputFile.sourcePath, destination)
  }

  return copied
}

function validatePythonImports(
  code: string,
  backend: CodeExecutionBackend
): string | null {
  const lines = code.split(/\r?\n/g)
  const allowedImports =
    backend === "finance"
      ? PYTHON_FINANCE_ALLOWED_IMPORTS
      : PYTHON_ALLOWED_IMPORTS

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
        if (rootModule && !allowedImports.has(rootModule)) {
          return `Python imports are limited to safe computation modules. Blocked import: ${rootModule}.`
        }
      }
    }

    const fromMatch = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/.exec(line)
    const rootModule = fromMatch?.[1]?.split(".")[0]
    if (rootModule && !allowedImports.has(rootModule)) {
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

  if (args.backend === "finance") {
    const pathLiteralError = validatePathStringLiterals(args.code)
    if (pathLiteralError) {
      return pathLiteralError
    }
  }

  return validatePythonImports(args.code, args.backend)
}

async function runProcess(args: {
  command: string
  commandArgs: string[]
  language?: CodeExecutionLanguage
  timeoutMs: number
  backend: CodeExecutionBackend
  workspaceMode: CodeExecutionWorkspaceMode
  workspaceRoot?: string
  inputFiles?: CodeExecutionInputFile[]
}): Promise<CodeExecutionToolResultPayload> {
  const startedAt = Date.now()
  const normalizedWorkspaceRoot = args.workspaceRoot?.trim()
  const tempRoot =
    normalizedWorkspaceRoot && normalizedWorkspaceRoot.length > 0
      ? normalizedWorkspaceRoot
      : tmpdir()
  await mkdir(tempRoot, { recursive: true })
  const tempDir =
    args.workspaceMode === "preserve"
      ? tempRoot
      : await mkdtemp(path.join(tempRoot, "chloei-code-exec-"))
  const workspaceDir = path.join(tempDir, "workspace")
  await mkdir(workspaceDir, { recursive: true })
  const copiedInputFiles = await copyInputFiles(workspaceDir, args.inputFiles)
  const commandArgs =
    args.language === "python" &&
    args.commandArgs[0] === "-I" &&
    args.commandArgs[1] === "-c" &&
    typeof args.commandArgs[2] === "string"
      ? [
          "-I",
          "-c",
          buildPythonSandboxedCode(args.commandArgs[2], workspaceDir, tempDir),
        ]
      : args.commandArgs

  let stdout = ""
  let stderr = ""
  let truncated = false
  let timedOut = false

  const collectManifest = async (): Promise<CodeExecutionArtifact[]> =>
    collectArtifactManifest(workspaceDir, copiedInputFiles)

  try {
    return await new Promise<CodeExecutionToolResultPayload>((resolve) => {
      let settled = false
      const child = spawn(args.command, commandArgs, {
        cwd: workspaceDir,
        env: {
          ...process.env,
          HOME: tempDir,
          PATH: process.env.PATH ?? "",
          PYTHONNOUSERSITE: "1",
          TMPDIR: tempDir,
          TMP: tempDir,
          TEMP: tempDir,
          MPLBACKEND: "Agg",
          MPLCONFIGDIR: path.join(tempDir, "matplotlib"),
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
        void (async () => {
          const durationMs = Date.now() - startedAt
          const combinedOutput = buildCombinedOutput(stdout, stderr)
          const artifactManifest = await collectManifest()
          const artifactDirectory =
            args.workspaceMode === "preserve" ? workspaceDir : undefined

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
                backend: args.backend,
                artifactManifest,
                ...(artifactDirectory ? { artifactDirectory } : {}),
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
                backend: args.backend,
                artifactManifest,
                ...(artifactDirectory ? { artifactDirectory } : {}),
              },
            })
            return
          }

          finish({
            output: {
              language: args.language ?? inferLanguageFromCommand(args.command),
              exitCode: normalizedExitCode,
              stdout,
              stderr,
              combinedOutput,
              durationMs,
              truncated,
              backend: args.backend,
              artifactManifest,
              ...(artifactDirectory ? { artifactDirectory } : {}),
            },
          })
        })().catch((error: unknown) => {
          finish({
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "Code execution artifact collection failed.",
              code: "ARTIFACT_COLLECTION_ERROR",
            },
          })
        })
      })

      const timeoutId = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, args.timeoutMs)
    })
  } finally {
    if (args.workspaceMode !== "preserve") {
      await rm(tempDir, { recursive: true, force: true })
    }
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
    const pythonCommand = resolvePythonCommand(args.backend)
    const result = await runProcess({
      command: pythonCommand,
      commandArgs: ["-I", "-c", args.code],
      language: "python",
      timeoutMs: args.timeoutMs,
      backend: args.backend,
      workspaceMode: args.workspaceMode,
      workspaceRoot: args.workspaceRoot,
      inputFiles: args.inputFiles,
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
    language: "javascript",
    timeoutMs: args.timeoutMs,
    backend: args.backend,
    workspaceMode: args.workspaceMode,
    workspaceRoot: args.workspaceRoot,
    inputFiles: args.inputFiles,
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

export function createAiSdkCodeExecutionTools(
  options: CreateAiSdkCodeExecutionToolsOptions = {}
) {
  const backend = normalizeBackend(
    options.backend ?? AGENT_CODE_EXECUTION_BACKEND
  )
  const workspaceMode = options.workspaceMode ?? "ephemeral"
  const workspaceRoot =
    options.workspaceRoot ??
    (workspaceMode === "preserve"
      ? path.join(tmpdir(), `chloei-code-exec-${randomUUID()}`)
      : undefined)

  return {
    code_execution: tool({
      description:
        backend === "finance"
          ? "Execute small self-contained JavaScript or curated Python finance-analysis snippets for arithmetic, statistics, table transformations, spreadsheet generation, chart generation, or quick validation. Network, subprocess, and host filesystem access are blocked. In finance/eval mode, mounted reference files may be read by relative path with libraries such as pandas/openpyxl, and generated workspace artifacts are reported in an artifact manifest. For spreadsheet deliverables, write relative filenames directly with library save APIs such as DataFrame.to_excel('deliverable.xlsx'), Workbook.save('deliverable.xlsx'), or plt.savefig('chart.png'). Do not create scratch/test/probe files; every generated file may be treated as a submitted artifact. Avoid blocked APIs such as open(), pathlib, os, subprocess, requests, urllib, and sockets."
          : "Execute small self-contained JavaScript or Python snippets for arithmetic, logic checks, data transformations, or quick validation. This tool cannot access the network, filesystem, or subprocesses.",
      inputSchema: codeExecutionInputSchema,
      execute: async (input) =>
        executeCode({
          language: input.language,
          code: input.code,
          timeoutMs: clampTimeoutMs(input.timeoutMs),
          backend,
          workspaceMode,
          workspaceRoot,
          inputFiles: options.inputFiles,
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
    operation: normalizeLanguage(asRecord(part.input)?.language),
    provider: "local",
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
    operation: payload?.output?.language ?? payload?.error?.language,
    provider: "local",
    durationMs: payload?.output?.durationMs ?? payload?.error?.durationMs,
    errorCode: payload?.error?.code,
    retryable: payload?.error?.timedOut === true,
    sources: [],
  }
}
