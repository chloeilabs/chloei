#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  gradeFinanceOutput,
  loadJsonl,
  summarizeResults,
  writeEvalResult,
} from "./harness.mjs"

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(evalDir, "../..")

function getArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1] ?? fallback
}

const inputPath = path.resolve(
  repoRoot,
  getArg("--input", "evals/finance/tasks/internal.jsonl")
)
const outputsPath = getArg("--outputs", null)
if (!outputsPath) {
  throw new Error("Missing --outputs path.")
}

const tasks = await loadJsonl(inputPath)
const outputs = JSON.parse(
  await readFile(path.resolve(repoRoot, outputsPath), "utf8")
)
const outputByTaskId = new Map(
  (Array.isArray(outputs) ? outputs : (outputs.results ?? [])).map((output) => [
    output.taskId,
    output.output ?? output,
  ])
)

const results = tasks.map((task) => {
  const output = outputByTaskId.get(task.id) ?? { text: "" }
  return {
    taskId: task.id,
    category: task.category,
    output,
    grade: gradeFinanceOutput(task, output),
  }
})

const result = {
  mode: "grade",
  inputPath,
  outputsPath,
  generatedAt: new Date().toISOString(),
  summary: summarizeResults(results),
  results,
}

const outputPath = path.resolve(
  repoRoot,
  getArg("--output", "evals/finance/results/finance-grade.json")
)
await writeEvalResult(result, outputPath)
console.log(JSON.stringify({ outputPath, summary: result.summary }, null, 2))

if (result.summary.failed > 0) {
  process.exitCode = 1
}
