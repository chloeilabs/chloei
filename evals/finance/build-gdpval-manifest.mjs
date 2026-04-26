#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadJsonl, writeEvalResult } from "./harness.mjs"

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(evalDir, "../..")

const FINANCE_OCCUPATION_PATTERN =
  /\b(accountant|auditor|financial|investment|advisor|securities|commodities|sales agent|financial manager)\b/i
const FINANCE_INDUSTRY_PATTERN =
  /\b(finance|financial|bank|banking|insurance|investment|investments|broker|accounting|accountant|mortgage|lending|capital)\b/i
const FINANCE_PROMPT_PATTERN =
  /\b(finance|financial|revenue|expense|margin|budget|statement|audit|tax|portfolio|investment|valuation|cash flow|spreadsheet|workbook)\b/i

function getArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1] ?? fallback
}

const inputPath = path.resolve(repoRoot, getArg("--input", "gdpval.jsonl"))
const outputPath = path.resolve(
  repoRoot,
  getArg("--output", "evals/finance/tasks/gdpval-finance-manifest.json")
)

const rows = await loadJsonl(inputPath)
const tasks = rows.filter((row) => {
  const industry = String(row.industry ?? row.sector ?? "")
  const occupation = String(row.occupation ?? "")
  const prompt = String(row.prompt ?? row.task ?? "")

  return (
    FINANCE_INDUSTRY_PATTERN.test(industry) ||
    FINANCE_OCCUPATION_PATTERN.test(occupation) ||
    FINANCE_PROMPT_PATTERN.test(prompt)
  )
})

await writeEvalResult(
  {
    generatedAt: new Date().toISOString(),
    source: inputPath,
    taskCount: tasks.length,
    tasks,
  },
  outputPath
)

console.log(JSON.stringify({ outputPath, taskCount: tasks.length }, null, 2))
