#!/usr/bin/env node
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { writeEvalResult } from "./harness.mjs"

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(evalDir, "../..")

function getArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1] ?? fallback
}

function getFlag(name) {
  return process.argv.includes(name)
}

function parseEnvLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) {
    return null
  }

  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
  if (!match) {
    return null
  }

  const [, key, rawValue] = match
  let value = rawValue.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }

  return [key, value]
}

async function loadEnvFile(filePath) {
  const source = await readFile(filePath, "utf8").catch(() => null)
  if (!source) {
    return
  }

  for (const line of source.split(/\r?\n/g)) {
    const parsed = parseEnvLine(line)
    if (!parsed) {
      continue
    }

    const [key, value] = parsed
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

function trimToBudget(text, budget) {
  if (!text || text.length <= budget) {
    return text
  }

  return `${text.slice(0, budget)}\n\n[TRUNCATED: kept ${budget} of ${text.length} characters]`
}

function hashId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function safeFileName(value) {
  return String(value ?? "artifact")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .slice(0, 120)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableErrorMessage(message) {
  return /\b(rate[_ -]?limit|429|5\d\d|timeout|timed out|temporarily|overloaded|try again|tokens per min|tpm)\b/i.test(
    message
  )
}

function isInsufficientQuotaMessage(message) {
  return /\b(insufficient_quota|exceeded your current quota)\b/i.test(message)
}

function shouldRetryTaskResult(result) {
  if (result.status === "failed") {
    return isRetryableErrorMessage(result.error ?? "")
  }

  return (
    result.status === "completed" &&
    result.output.text.trim().length === 0 &&
    result.output.artifacts.length === 0
  )
}

function markEmptyCompletedAsFailed(result) {
  if (
    result.status === "completed" &&
    result.output.text.trim().length === 0 &&
    result.output.artifacts.length === 0
  ) {
    return {
      ...result,
      status: "failed",
      error:
        "Agent stream completed without final text or submitted artifacts.",
    }
  }

  return result
}

async function listFiles(rootDir) {
  const files = []

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => []
    )

    for (const entry of entries) {
      if (
        entry.name === "__pycache__" ||
        entry.name === "normalized-artifacts"
      ) {
        continue
      }

      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }

      const info = await stat(fullPath).catch(() => null)
      if (!info?.isFile()) {
        continue
      }

      const relativeToRoot = path.relative(rootDir, fullPath)
      if (
        relativeToRoot.includes(
          `${path.sep}workspace${path.sep}reference${path.sep}`
        )
      ) {
        continue
      }

      files.push({
        path: fullPath,
        relativePath: path.relative(repoRoot, fullPath),
        sizeBytes: info.size,
      })
    }
  }

  await walk(rootDir)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function fileExists(filePath) {
  const info = await stat(filePath).catch(() => null)
  return Boolean(info?.isFile())
}

async function loadReferenceFileMap(filePath) {
  if (!filePath || !(await fileExists(filePath))) {
    return new Map()
  }

  const index = JSON.parse(await readFile(filePath, "utf8"))
  const files = Array.isArray(index.files) ? index.files : []
  const map = new Map()
  for (const file of files) {
    if (file?.url && file?.localPath && (await fileExists(file.localPath))) {
      map.set(file.url, file)
    }
  }

  return map
}

async function buildTaskInputFiles(task) {
  const inputFiles = []
  const lines = []
  const urls = Array.isArray(task.reference_file_urls)
    ? task.reference_file_urls
    : []

  for (const [index, url] of urls.entries()) {
    const file = referenceFilesByUrl.get(url)
    if (!file?.localPath || !(await fileExists(file.localPath))) {
      continue
    }

    const fileName = safeFileName(
      file.fileName ?? path.basename(file.localPath)
    )
    const relativePath = `reference/${String(index + 1).padStart(
      2,
      "0"
    )}-${fileName}`
    inputFiles.push({
      sourcePath: file.localPath,
      relativePath,
    })
    lines.push(`- ${relativePath} (${fileName})`)
  }

  return { inputFiles, lines }
}

function runPython(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`Python extractor timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(`Python extractor exited ${code}: ${stderr || stdout}`)
        )
      }
    })
  })
}

async function extractArtifactContext(taskId, artifact) {
  const ext = path.extname(artifact.path).toLowerCase()
  if (
    ![
      ".csv",
      ".docx",
      ".html",
      ".json",
      ".md",
      ".pdf",
      ".txt",
      ".xlsx",
      ".zip",
    ].includes(ext)
  ) {
    return null
  }

  const outputPath = path.join(
    artifactRoot,
    "normalized-artifacts",
    `${taskId}-${hashId(artifact.relativePath)}-${safeFileName(path.basename(artifact.path))}.json`
  )

  try {
    await runPython(
      [
        extractorPath,
        "--input",
        artifact.path,
        "--output",
        outputPath,
        "--url",
        artifact.relativePath,
        "--max-chars",
        String(artifactContextMaxChars),
        "--xlsx-max-rows",
        String(artifactXlsxMaxRows),
        "--xlsx-max-cols",
        String(artifactXlsxMaxCols),
        "--xlsx-formula-limit",
        String(artifactXlsxFormulaLimit),
      ],
      { timeoutMs: extractorTimeoutMs }
    )
    const record = JSON.parse(await readFile(outputPath, "utf8"))
    return {
      path: artifact.relativePath,
      kind: record.kind,
      status: record.status,
      truncated: record.truncated,
      warnings: record.warnings ?? [],
      text: trimToBudget(record.text ?? "", artifactContextMaxChars),
    }
  } catch (error) {
    return {
      path: artifact.relativePath,
      kind: "unknown",
      status: "error",
      truncated: false,
      warnings: [error instanceof Error ? error.message : String(error)],
      text: "",
    }
  }
}

const SCRATCH_ARTIFACT_STEMS = new Set([
  "a",
  "mini",
  "raw",
  "sample",
  "scratch",
  "test",
  "tmp",
  "weird",
  "x",
  "ztest",
])

function isLikelyScratchArtifact(artifact, finalText) {
  const baseName = path.basename(artifact.path).toLowerCase()
  if (finalText.toLowerCase().includes(baseName)) {
    return false
  }

  const stem = baseName.replace(/\.[^.]+$/, "")
  return (
    SCRATCH_ARTIFACT_STEMS.has(stem) ||
    /^test[_.-]/.test(stem) ||
    /^sample[_.-]/.test(stem) ||
    /^scratch[_.-]/.test(stem) ||
    /^tmp[_.-]/.test(stem)
  )
}

function filterSubmissionArtifacts(artifacts, finalText) {
  const filtered = artifacts.filter(
    (artifact) => !isLikelyScratchArtifact(artifact, finalText)
  )
  const bestByName = new Map()
  for (const artifact of filtered) {
    const key = path.basename(artifact.path).toLowerCase()
    const current = bestByName.get(key)
    if (!current || artifact.sizeBytes > current.sizeBytes) {
      bestByName.set(key, artifact)
    }
  }

  return [...bestByName.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  )
}

function buildCandidatePrompt(task, referenceContextText, inputFileLines) {
  const inputFileSection = inputFileLines.length
    ? `\nMounted reference files available inside every code_execution workspace:\n${inputFileLines.join(
        "\n"
      )}\nUse these exact relative paths with pandas/openpyxl when source workbooks or documents are needed.`
    : "\nMounted reference files: none."

  return [
    "Complete this GDPval-style task as Chloei.",
    "",
    "Important deliverable rules:",
    "- Produce the requested business output, not an explanation of how you would do it.",
    "- Every file created by code_execution is treated as a submitted deliverable. Do not create scratch, sample, probe, test, placeholder, or throwaway files.",
    "- If the task asks for a spreadsheet, chart, CSV, JSON, HTML, text file, or zip, use code_execution to generate the artifact in the workspace with a professional task-specific filename.",
    "- For Excel deliverables, use Python with pandas/openpyxl/xlsxwriter and direct relative saves such as df.to_excel('deliverable.xlsx', index=False), ExcelWriter(...), or Workbook.save('deliverable.xlsx'). Avoid open(), pathlib, os, subprocess, requests, urllib, sockets, and arbitrary network.",
    "- If mounted reference spreadsheets are available, load them directly with paths like pd.read_excel('reference/01-input.xlsx') instead of reconstructing data from text previews.",
    "- Preserve requested workbook sheet names, column names, column order, and formula definitions exactly when the task specifies them.",
    "- If the task asks for a Word/PDF-style document and you cannot generate that exact file type with available tools, create the closest rich fallback artifact (.md or .html) and also write the full document content in the final answer with the file-type limitation.",
    "- Use any provided reference file context as source data. Do not use public gold deliverables.",
    "- Keep the final answer concise and include an artifact manifest when files were generated.",
    inputFileSection,
    "",
    "Task prompt:",
    task.prompt,
    referenceContextText
      ? `\nReference file context:\n${referenceContextText}`
      : "\nReference file context: none provided.",
  ].join("\n")
}

function uniqueSources(sources) {
  const seen = new Set()
  const next = []

  for (const source of sources) {
    const key = source.url
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    next.push(source)
  }

  return next
}

async function runTaskOnce(task, attempt) {
  const startedAt = Date.now()
  const beforeArtifacts = new Set(
    (await listFiles(artifactRoot)).map((artifact) => artifact.path)
  )
  const referenceContextText = await readFile(
    path.join(referenceContextDir, `${task.task_id}.md`),
    "utf8"
  )
    .then((text) => trimToBudget(text, referenceContextMaxChars))
    .catch(() => "")
  const { inputFiles, lines: inputFileLines } = await buildTaskInputFiles(task)

  const prompt = buildCandidatePrompt(
    task,
    referenceContextText,
    inputFileLines
  )
  const taskMode = inferPromptTaskMode([{ role: "user", content: task.prompt }])
  const provider = resolvePromptProvider(model)
  const systemInstruction = withAiSdkInlineCitationInstruction(
    `${buildAgentSystemInstruction(
      {
        id: "gdpval-eval-runner",
        name: "Chloei Eval Runner",
        email: "eval@example.com",
      },
      {
        now: new Date(),
        userTimeZone,
        provider,
        taskMode,
      }
    )}\n\n--- BEGIN GDPVAL WORKSPACE EVAL INSTRUCTIONS ---\nYou are running in a benchmark workspace. Complete the user's requested deliverable as fully as the available tools allow. Prefer code_execution for deterministic calculations, tables, spreadsheets, charts, and file artifacts. Do not ask clarifying questions. If a requirement cannot be completed because the sandbox lacks a needed library or file type, state that limitation in the final answer and provide the best fallback deliverable content.\n--- END GDPVAL WORKSPACE EVAL INSTRUCTIONS ---`,
    {
      fmpEnabled: Boolean(process.env.FMP_API_KEY?.trim()),
    }
  )

  const toolCalls = []
  const toolCallsById = new Map()
  const sources = []
  let text = ""
  let agentStatus = null

  try {
    const signal = AbortSignal.timeout(taskTimeoutMs)
    const stream = startAgentRuntimeStream({
      model,
      aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      fmpApiKey: process.env.FMP_API_KEY,
      fredApiKey: process.env.FRED_API_KEY,
      secUserAgent: process.env.SEC_API_USER_AGENT,
      userTimeZone,
      runtimeProfile: "gdpval_workspace",
      messages: [{ role: "user", content: prompt }],
      systemInstruction,
      codeExecutionInputFiles: inputFiles,
      signal,
    })

    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta
        continue
      }

      if (event.type === "source") {
        sources.push(event.source)
        continue
      }

      if (event.type === "agent_status") {
        agentStatus = event.status
        continue
      }

      if (event.type === "tool_call") {
        const call = {
          callId: event.callId,
          toolName: event.toolName,
          label: event.label,
          ...(event.query ? { query: event.query } : {}),
          ...(event.operation ? { operation: event.operation } : {}),
          ...(event.provider ? { provider: event.provider } : {}),
          status: "running",
        }
        toolCalls.push(call)
        toolCallsById.set(event.callId, call)
        continue
      }

      if (event.type === "tool_result") {
        const call = toolCallsById.get(event.callId)
        if (call) {
          call.status = event.status
          if (event.durationMs !== undefined) {
            call.durationMs = event.durationMs
          }
          if (event.errorCode) {
            call.errorCode = event.errorCode
          }
          if (event.retryable !== undefined) {
            call.retryable = event.retryable
          }
        } else {
          toolCalls.push({
            callId: event.callId,
            toolName: event.toolName ?? "unknown",
            status: event.status,
            ...(event.operation ? { operation: event.operation } : {}),
            ...(event.provider ? { provider: event.provider } : {}),
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          })
        }
      }
    }

    const afterArtifacts = await listFiles(artifactRoot)
    const rawArtifacts = afterArtifacts.filter(
      (artifact) => !beforeArtifacts.has(artifact.path)
    )
    const artifacts = filterSubmissionArtifacts(rawArtifacts, text)
    const artifactContexts = (
      await Promise.all(
        artifacts.map((artifact) =>
          extractArtifactContext(task.task_id, artifact)
        )
      )
    ).filter(Boolean)

    return {
      taskId: task.task_id,
      sector: task.sector,
      occupation: task.occupation,
      status: "completed",
      attempt,
      durationMs: Date.now() - startedAt,
      agentStatus,
      output: {
        text: text.trim(),
        toolCalls,
        sources: uniqueSources(sources),
        artifacts: artifacts.map((artifact) => ({
          path: artifact.relativePath,
          sizeBytes: artifact.sizeBytes,
        })),
        rawArtifacts:
          rawArtifacts.length === artifacts.length
            ? undefined
            : rawArtifacts.map((artifact) => ({
                path: artifact.relativePath,
                sizeBytes: artifact.sizeBytes,
              })),
        artifactContexts,
      },
    }
  } catch (error) {
    return {
      taskId: task.task_id,
      sector: task.sector,
      occupation: task.occupation,
      status: "failed",
      attempt,
      durationMs: Date.now() - startedAt,
      error: getErrorMessage(error),
      output: {
        text: text.trim(),
        toolCalls,
        sources: uniqueSources(sources),
        artifacts: [],
        artifactContexts: [],
      },
    }
  }
}

async function runTask(task) {
  let lastResult = null
  for (let attempt = 1; attempt <= taskRetryAttempts; attempt += 1) {
    const result = markEmptyCompletedAsFailed(await runTaskOnce(task, attempt))
    lastResult = result
    if (!shouldRetryTaskResult(result) || attempt >= taskRetryAttempts) {
      return result
    }

    const delayMs = taskRetryBaseDelayMs * 2 ** (attempt - 1)
    console.warn(
      JSON.stringify({
        taskId: task.task_id,
        status: "retrying",
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: result.error,
      })
    )
    await sleep(delayMs)
  }

  return lastResult
}

const manifestPath = path.resolve(
  repoRoot,
  getArg("--manifest", "evals/finance/results/gdpval-finance-manifest.json")
)
const outputPath = path.resolve(
  repoRoot,
  getArg(
    "--output",
    `evals/finance/results/gdpval-chloei-candidates-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  )
)
const envPath = path.resolve(repoRoot, getArg("--env-file", ".env.local"))
const model = getArg("--model", "openai/gpt-5.4-mini")
const limit = Number(getArg("--limit", "3"))
const offset = Number(getArg("--offset", "0"))
const userTimeZone = getArg("--user-time-zone", "America/Chicago")
const referenceContextDir = path.resolve(
  repoRoot,
  getArg(
    "--reference-context-dir",
    "evals/finance/cache/gdpval-reference/task-contexts"
  )
)
const referenceIndexPath = path.resolve(
  repoRoot,
  getArg(
    "--reference-index",
    "evals/finance/results/gdpval-reference-normalized.json"
  )
)
const referenceContextMaxChars = Number(
  getArg("--reference-context-max-chars", "200000")
)
const artifactRoot = path.resolve(
  repoRoot,
  getArg(
    "--artifact-root",
    `evals/finance/results/chloei-gdpval-artifacts-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`
  )
)
const artifactContextMaxChars = Number(
  getArg("--artifact-context-max-chars", "60000")
)
const artifactXlsxMaxRows = Number(getArg("--artifact-xlsx-max-rows", "1000"))
const artifactXlsxMaxCols = Number(getArg("--artifact-xlsx-max-cols", "80"))
const artifactXlsxFormulaLimit = Number(
  getArg("--artifact-xlsx-formula-limit", "600")
)
const taskTimeoutMs = Number(getArg("--task-timeout-ms", "800000"))
const taskRetryAttempts = Math.max(
  1,
  Number(getArg("--task-retry-attempts", "3"))
)
const taskRetryBaseDelayMs = Math.max(
  0,
  Number(getArg("--task-retry-base-delay-ms", "45000"))
)
const taskDelayMs = Math.max(0, Number(getArg("--task-delay-ms", "0")))
const extractorPath = path.resolve(
  repoRoot,
  getArg("--extractor", "evals/finance/extract-gdpval-file.py")
)
const extractorTimeoutMs = Number(getArg("--extractor-timeout-ms", "180000"))
const explicitPythonPath = getArg("--python", null)
let pythonPath =
  explicitPythonPath ?? process.env.GDPVAL_EXTRACT_PYTHON ?? "python3"
const continueOnError = getFlag("--continue-on-error")

await loadEnvFile(envPath)
process.env.AGENT_EVAL_RESULTS_DIR = artifactRoot
process.env.AGENT_TOOL_MAX_STEPS ||= getArg("--tool-max-steps", "20")

const defaultFinanceVenvPath = path.join(
  repoRoot,
  "evals/finance/cache/python-finance-venv"
)
if (
  !process.env.AGENT_CODE_EXECUTION_PYTHON_VENV_PATH &&
  (await fileExists(path.join(defaultFinanceVenvPath, "bin", "python")))
) {
  process.env.AGENT_CODE_EXECUTION_PYTHON_VENV_PATH = defaultFinanceVenvPath
}
if (
  !explicitPythonPath &&
  !process.env.GDPVAL_EXTRACT_PYTHON &&
  (await fileExists(path.join(defaultFinanceVenvPath, "bin", "python")))
) {
  pythonPath = path.join(defaultFinanceVenvPath, "bin", "python")
}

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error(
    "Missing AI_GATEWAY_API_KEY. Provide it via .env.local or env."
  )
}

await mkdir(artifactRoot, { recursive: true })
await import("./register-ts-hooks.mjs")

const { startAgentRuntimeStream } =
  await import("../../src/lib/server/llm/agent-runtime.ts")
const { buildAgentSystemInstruction } =
  await import("../../src/lib/server/agent-context.ts")
const { inferPromptTaskMode, resolvePromptProvider } =
  await import("../../src/lib/server/agent-prompt-steering.ts")
const { withAiSdkInlineCitationInstruction } =
  await import("../../src/lib/server/llm/system-instruction-augmentations.ts")

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const referenceFilesByUrl = await loadReferenceFileMap(referenceIndexPath)
const tasks = manifest.tasks.slice(offset, offset + limit)
const results = []

function buildOutput(results) {
  const completed = results.filter((result) => result.status === "completed")
  const failed = results.filter((result) => result.status === "failed")
  const withArtifacts = completed.filter(
    (result) => result.output.artifacts.length > 0
  )
  const withToolErrors = completed.filter((result) =>
    result.output.toolCalls.some((call) => call.status === "error")
  )

  return {
    mode: "chloei_candidate",
    generatedAt: new Date().toISOString(),
    manifestPath,
    source: manifest.source,
    model,
    runtimeProfile: "gdpval_workspace",
    referenceContextDir,
    referenceIndexPath,
    mountedReferenceFileCount: referenceFilesByUrl.size,
    referenceContextMaxChars,
    artifactRoot,
    artifactContextMaxChars,
    artifactExtractorOptions: {
      xlsxMaxRows: artifactXlsxMaxRows,
      xlsxMaxCols: artifactXlsxMaxCols,
      xlsxFormulaLimit: artifactXlsxFormulaLimit,
    },
    taskRetry: {
      attempts: taskRetryAttempts,
      baseDelayMs: taskRetryBaseDelayMs,
    },
    taskDelayMs,
    offset,
    limit,
    checkpoint: {
      requested: tasks.length,
      attempted: results.length,
      remaining: Math.max(0, tasks.length - results.length),
    },
    summary: {
      requested: tasks.length,
      completed: completed.length,
      failed: failed.length,
      withArtifacts: withArtifacts.length,
      withToolErrors: withToolErrors.length,
      averageTextChars:
        completed.length > 0
          ? completed.reduce(
              (total, result) => total + result.output.text.length,
              0
            ) / completed.length
          : null,
    },
    results,
  }
}

for (const task of tasks) {
  const result = await runTask(task)
  results.push(result)
  await writeEvalResult(buildOutput(results), outputPath)
  console.log(
    JSON.stringify({
      taskId: result.taskId,
      status: result.status,
      durationMs: result.durationMs,
      textChars: result.output.text.length,
      toolCalls: result.output.toolCalls.length,
      artifacts: result.output.artifacts.length,
      error: result.error,
    })
  )

  if (result.status === "failed" && !continueOnError) {
    break
  }

  if (
    result.status === "failed" &&
    isInsufficientQuotaMessage(result.error ?? "")
  ) {
    break
  }

  if (taskDelayMs > 0 && results.length < tasks.length) {
    await sleep(taskDelayMs)
  }
}

const output = buildOutput(results)
const failed = results.filter((result) => result.status === "failed")

await writeEvalResult(output, outputPath)
console.log(JSON.stringify({ outputPath, summary: output.summary }, null, 2))

if (failed.length > 0) {
  process.exitCode = 1
}
