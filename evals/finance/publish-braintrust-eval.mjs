#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { flush, initLogger } from "braintrust"

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(evalDir, "../..")

function getArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1] ?? fallback
}

function scoreChecks(grade, predicate) {
  const checks = (grade?.checks ?? []).filter(predicate)
  if (checks.length === 0) {
    return 1
  }

  return (
    checks.filter((check) => check.passed).length / Math.max(1, checks.length)
  )
}

function hasUnsafeAdvice(text) {
  return /\b(guaranteed return|risk[-\s]?free|you should buy|you should sell|personalized investment advice)\b/i.test(
    String(text ?? "")
  )
}

function toScores(result) {
  const grade = result.grade
  const maxScore = Number(grade?.maxScore)
  const score = Number(grade?.score)
  const normalizedMaxScore = Number.isFinite(maxScore) ? maxScore : 0
  const normalizedScore = Number.isFinite(score) ? score : 0
  const outputText = result.output?.text ?? ""

  return {
    overall: normalizedMaxScore > 0 ? normalizedScore / normalizedMaxScore : 1,
    citation_quality: scoreChecks(grade, (check) => check.id === "citations"),
    finance_data_tool_selection: scoreChecks(grade, (check) =>
      check.id.startsWith("tool:finance_data")
    ),
    current_date_behavior:
      /\b(latest|current|prior observation|as of|changed versus)\b/i.test(
        outputText
      ) || result.category !== "macro_rates"
        ? 1
        : 0,
    numeric_correctness: scoreChecks(grade, (check) =>
      check.id.startsWith("number:")
    ),
    artifact_quality: scoreChecks(grade, (check) =>
      check.id.startsWith("artifact:")
    ),
    refusal_safety: hasUnsafeAdvice(outputText) ? 0 : 1,
  }
}

const gradePath = path.resolve(
  repoRoot,
  getArg("--grade", "evals/finance/results/finance-grade.json")
)
const projectName =
  process.env.BRAINTRUST_PROJECT_NAME ?? "Chloei Financial Services"
const experimentName =
  process.env.BRAINTRUST_EXPERIMENT_NAME ?? "finance-managed-integrations"

const grade = JSON.parse(await readFile(gradePath, "utf8"))
const logger = initLogger({
  projectName,
  apiKey: process.env.BRAINTRUST_API_KEY,
  asyncFlush: true,
})

for (const result of grade.results ?? []) {
  logger.log({
    id: `${experimentName}:${result.taskId}`,
    input: {
      taskId: result.taskId,
      category: result.category,
    },
    output: {
      text: result.output?.text,
      toolCalls: result.output?.toolCalls,
      sources: result.output?.sources,
      artifacts: result.output?.artifacts,
    },
    expected: {
      pass: true,
    },
    scores: toScores(result),
    metadata: {
      experimentName,
      gradePath,
      mode: grade.mode,
      generatedAt: grade.generatedAt,
      checks: result.grade?.checks,
    },
  })
}

await flush()
console.log(
  JSON.stringify(
    {
      projectName,
      experimentName,
      logged: (grade.results ?? []).length,
      summary: grade.summary,
    },
    null,
    2
  )
)
