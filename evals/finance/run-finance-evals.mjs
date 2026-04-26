#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runFixtureEval, writeEvalResult } from "./harness.mjs"

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
const resultsDir = path.resolve(
  repoRoot,
  process.env.AGENT_EVAL_RESULTS_DIR ||
    getArg("--results-dir", "evals/finance/results")
)
const outputPath = path.join(
  resultsDir,
  `finance-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
)

const result = await runFixtureEval({ inputPath })
await writeEvalResult(result, outputPath)

console.log(
  JSON.stringify(
    {
      outputPath,
      summary: result.summary,
    },
    null,
    2
  )
)

if (result.summary.failed > 0) {
  process.exitCode = 1
}
