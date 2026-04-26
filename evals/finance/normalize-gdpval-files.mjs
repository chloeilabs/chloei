#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
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

function getContextRoles(value) {
  const normalized = String(value ?? "both")
    .trim()
    .toLowerCase()

  if (normalized === "reference") {
    return new Set(["reference"])
  }

  if (normalized === "deliverable") {
    return new Set(["deliverable"])
  }

  return new Set(["reference", "deliverable"])
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function safeFileName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 180)
}

function decodeFileName(url) {
  const pathname = new URL(url).pathname
  const fileName = path.basename(pathname)
  return safeFileName(decodeURIComponent(fileName || "file"))
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown size"
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function trimToBudget(text, budget) {
  if (text.length <= budget) {
    return text
  }

  return `${text.slice(0, budget)}\n\n[TRUNCATED: kept ${budget} of ${text.length} characters]`
}

async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function downloadFile(url, outputPath, { force }) {
  if (!force && (await fileExists(outputPath))) {
    return { downloaded: false }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download failed ${response.status}: ${url}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, buffer)

  return { downloaded: true, sizeBytes: buffer.byteLength }
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

async function normalizeFile(entry, { force }) {
  const needsExtract = force || !(await fileExists(entry.normalizedPath))
  if (!needsExtract) {
    return JSON.parse(await readFile(entry.normalizedPath, "utf8"))
  }

  await runPython(
    [
      extractorPath,
      "--input",
      entry.localPath,
      "--output",
      entry.normalizedPath,
      "--url",
      entry.url,
      "--max-chars",
      String(fileMaxChars),
      "--xlsx-max-rows",
      String(xlsxMaxRows),
      "--xlsx-max-cols",
      String(xlsxMaxCols),
      "--xlsx-formula-limit",
      String(xlsxFormulaLimit),
    ],
    { timeoutMs: extractorTimeoutMs }
  )

  return JSON.parse(await readFile(entry.normalizedPath, "utf8"))
}

function fileSection(entry, record) {
  return [
    `### ${entry.role.toUpperCase()} File: ${record.fileName}`,
    `URL: ${entry.url}`,
    `Kind: ${record.kind}; extraction status: ${record.status}; size: ${formatBytes(record.sizeBytes)}; truncated: ${record.truncated}`,
    record.warnings?.length
      ? `Warnings: ${record.warnings.join("; ")}`
      : "Warnings: none",
    "",
    record.text || "[No extracted text]",
  ].join("\n")
}

async function writeTaskContext(task, filesByUrl, contextPath) {
  const sections = [
    `# GDPval Normalized File Context`,
    `Task ID: ${task.task_id}`,
    `Sector: ${task.sector}`,
    `Occupation: ${task.occupation}`,
    "",
    contextRoles.has("deliverable")
      ? "This context was extracted from local cached GDPval reference and gold deliverable files. Use it as the primary file evidence. If content is truncated or extraction is limited, reflect that in file_access and confidence."
      : "This context was extracted from local cached GDPval reference files only. It is suitable for candidate generation and does not include public gold deliverables.",
  ]

  const entries = []
  if (contextRoles.has("reference")) {
    entries.push(
      ...(task.reference_file_urls ?? []).map((url) => ({
        role: "reference",
        url,
      }))
    )
  }
  if (contextRoles.has("deliverable")) {
    entries.push(
      ...(task.deliverable_file_urls ?? []).map((url) => ({
        role: "deliverable",
        url,
      }))
    )
  }

  for (const entry of entries) {
    const file = filesByUrl.get(entry.url)
    if (!file) {
      sections.push(
        `\n### ${entry.role.toUpperCase()} File: missing`,
        entry.url
      )
      continue
    }

    sections.push("", fileSection({ ...entry, url: file.url }, file.record))
  }

  await mkdir(path.dirname(contextPath), { recursive: true })
  await writeFile(
    contextPath,
    trimToBudget(sections.join("\n"), taskContextMaxChars)
  )
}

const manifestPath = path.resolve(
  repoRoot,
  getArg("--manifest", "evals/finance/results/gdpval-finance-manifest.json")
)
const cacheDir = path.resolve(
  repoRoot,
  getArg("--cache-dir", "evals/finance/cache/gdpval")
)
const outputPath = path.resolve(
  repoRoot,
  getArg("--output", path.join(cacheDir, "index.json"))
)
const pythonPath = getArg(
  "--python",
  process.env.GDPVAL_EXTRACT_PYTHON ?? "python3"
)
const extractorPath = path.resolve(
  repoRoot,
  getArg("--extractor", "evals/finance/extract-gdpval-file.py")
)
const fileMaxChars = Number(getArg("--file-max-chars", "120000"))
const taskContextMaxChars = Number(getArg("--task-context-max-chars", "180000"))
const extractorTimeoutMs = Number(getArg("--extractor-timeout-ms", "180000"))
const xlsxMaxRows = Number(getArg("--xlsx-max-rows", "1000"))
const xlsxMaxCols = Number(getArg("--xlsx-max-cols", "80"))
const xlsxFormulaLimit = Number(getArg("--xlsx-formula-limit", "600"))
const limit = Number(getArg("--limit", "Infinity"))
const offset = Number(getArg("--offset", "0"))
const force = getFlag("--force")
const contextRoles = getContextRoles(getArg("--context-roles", "both"))

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const tasks = manifest.tasks.slice(
  offset,
  Number.isFinite(limit) ? offset + limit : undefined
)
const filesDir = path.join(cacheDir, "files")
const normalizedDir = path.join(cacheDir, "normalized")
const contextDir = path.join(cacheDir, "task-contexts")
const urls = new Set()

for (const task of tasks) {
  if (contextRoles.has("reference")) {
    for (const url of task.reference_file_urls ?? []) {
      urls.add(url)
    }
  }
  if (contextRoles.has("deliverable")) {
    for (const url of task.deliverable_file_urls ?? []) {
      urls.add(url)
    }
  }
}

await mkdir(filesDir, { recursive: true })
await mkdir(normalizedDir, { recursive: true })
await mkdir(contextDir, { recursive: true })

const filesByUrl = new Map()
const fileResults = []
let completed = 0

for (const url of urls) {
  const id = sha256(url)
  const fileName = decodeFileName(url)
  const localPath = path.join(filesDir, `${id}-${fileName}`)
  const normalizedPath = path.join(normalizedDir, `${id}.json`)
  const entry = { id, url, fileName, localPath, normalizedPath }

  try {
    const download = await downloadFile(url, localPath, { force })
    const record = await normalizeFile(entry, { force })
    const result = {
      ...entry,
      downloaded: download.downloaded,
      status: record.status,
      kind: record.kind,
      sizeBytes: record.sizeBytes,
      warnings: record.warnings ?? [],
    }
    filesByUrl.set(url, { ...entry, record })
    fileResults.push(result)
  } catch (error) {
    const record = {
      fileName,
      status: "error",
      kind: "unknown",
      sizeBytes: null,
      truncated: false,
      text: `[Normalization failed: ${error instanceof Error ? error.message : String(error)}]`,
      warnings: [error instanceof Error ? error.message : String(error)],
    }
    filesByUrl.set(url, { ...entry, record })
    fileResults.push({
      ...entry,
      status: "error",
      kind: "unknown",
      sizeBytes: null,
      warnings: record.warnings,
    })
  }

  completed += 1
  if (completed % 25 === 0 || completed === urls.size) {
    console.log(`normalized ${completed}/${urls.size} files`)
  }
}

const taskContexts = []
for (const task of tasks) {
  const contextPath = path.join(contextDir, `${task.task_id}.md`)
  await writeTaskContext(task, filesByUrl, contextPath)
  taskContexts.push({
    taskId: task.task_id,
    path: contextPath,
    relativePath: path.relative(repoRoot, contextPath),
  })
}

const statusCounts = {}
const kindCounts = {}
for (const result of fileResults) {
  statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1
  kindCounts[result.kind] = (kindCounts[result.kind] ?? 0) + 1
}

await writeEvalResult(
  {
    generatedAt: new Date().toISOString(),
    manifestPath,
    cacheDir,
    contextRoles: [...contextRoles],
    extractorOptions: {
      fileMaxChars,
      taskContextMaxChars,
      xlsxMaxRows,
      xlsxMaxCols,
      xlsxFormulaLimit,
    },
    filesDir,
    normalizedDir,
    contextDir,
    offset,
    limit: Number.isFinite(limit) ? limit : null,
    taskCount: tasks.length,
    fileCount: fileResults.length,
    summary: {
      statusCounts,
      kindCounts,
    },
    files: fileResults,
    taskContexts,
  },
  outputPath
)

console.log(
  JSON.stringify(
    {
      outputPath,
      contextDir,
      taskCount: tasks.length,
      fileCount: fileResults.length,
      summary: { statusCounts, kindCounts },
    },
    null,
    2
  )
)
