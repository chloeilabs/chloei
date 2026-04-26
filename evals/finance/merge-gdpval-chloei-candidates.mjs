#!/usr/bin/env node
import { readFile } from "node:fs/promises"
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

function getInputs() {
  const inputs = []
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--input" && process.argv[index + 1]) {
      inputs.push(process.argv[index + 1])
      index += 1
    }
  }

  return inputs
}

function hasUsableOutput(result) {
  return (
    result?.status === "completed" &&
    (result.output?.text?.trim()?.length > 0 ||
      (result.output?.artifacts?.length ?? 0) > 0)
  )
}

function normalizeResultOutput(result) {
  const output = result?.output ?? {}
  return {
    ...result,
    output: {
      ...output,
      text: typeof output.text === "string" ? output.text : "",
      artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : [],
      sources: Array.isArray(output.sources) ? output.sources : [],
      artifactContexts: Array.isArray(output.artifactContexts)
        ? output.artifactContexts
        : [],
    },
  }
}

const manifestPath = path.resolve(
  repoRoot,
  getArg("--manifest", "evals/finance/results/gdpval-finance-manifest.json")
)
const outputPath = path.resolve(
  repoRoot,
  getArg(
    "--output",
    `evals/finance/results/gdpval-chloei-candidates-merged-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  )
)
const completedOnly = !getFlag("--include-failed")
const inputPaths = getInputs().map((input) => path.resolve(repoRoot, input))

if (inputPaths.length === 0) {
  throw new Error("Provide one or more --input candidate result files.")
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const byTaskId = new Map()
const sources = []

for (const inputPath of inputPaths) {
  const file = JSON.parse(await readFile(inputPath, "utf8"))
  sources.push({
    path: inputPath,
    mode: file.mode,
    offset: file.offset,
    limit: file.limit,
    summary: file.summary,
  })

  for (const result of file.results ?? []) {
    if (completedOnly && !hasUsableOutput(result)) {
      continue
    }
    byTaskId.set(result.taskId, normalizeResultOutput(result))
  }
}

const results = []
const missingTaskIds = []
for (const task of manifest.tasks) {
  const result = byTaskId.get(task.task_id)
  if (result) {
    results.push(result)
  } else {
    missingTaskIds.push(task.task_id)
  }
}

const completed = results.filter((result) => result.status === "completed")
const failed = results.filter((result) => result.status === "failed")
const withArtifacts = completed.filter(
  (result) => result.output.artifacts.length > 0
)
const withToolErrors = completed.filter((result) =>
  result.output.toolCalls.some((call) => call.status === "error")
)

const output = {
  mode: "chloei_candidate_merged",
  generatedAt: new Date().toISOString(),
  manifestPath,
  source: manifest.source,
  inputPaths,
  sources,
  completedOnly,
  summary: {
    manifestTasks: manifest.tasks.length,
    mergedResults: results.length,
    missing: missingTaskIds.length,
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
  missingTaskIds,
  results,
}

await writeEvalResult(output, outputPath)
console.log(JSON.stringify({ outputPath, summary: output.summary }, null, 2))
