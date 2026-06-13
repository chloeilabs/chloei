import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const harnessUrl = pathToFileURL(
  path.join(cwd, "evals/finance/harness.mjs")
).href

const {
  buildLiveFinanceEvalOutput,
  extractExpectedNumericValues,
  gradeFinanceOutput,
  runFixtureEval,
} = await import(harnessUrl)

test("finance eval grader scores required tools, citations, terms, numbers, and artifacts", () => {
  const grade = gradeFinanceOutput(
    {
      id: "task-1",
      expectedTerms: ["gross margin"],
      requiredTools: ["finance_data", "code_execution"],
      minCitations: 1,
      expectedNumbers: [{ key: "grossMargin", value: 0.43, tolerance: 0.01 }],
      requiredArtifacts: [{ extension: ".xlsx", nameIncludes: "finance" }],
    },
    {
      text: "The gross margin calculation is complete. [SEC](https://example.com)",
      toolCalls: [{ toolName: "finance_data" }, { toolName: "code_execution" }],
      values: { grossMargin: 0.431 },
      artifacts: [{ path: "finance_model.xlsx", sizeBytes: 1024 }],
    }
  )

  assert.equal(grade.pass, true)
  assert.equal(grade.score, grade.maxScore)
})

test("finance eval grader accepts standard month abbreviations", () => {
  const grade = gradeFinanceOutput(
    {
      id: "month-abbreviation-task",
      expectedTerms: ["June", "July", "October", "November", "December"],
    },
    {
      text: "The table covers Jun. 1-30, Jul 1-31, Oct 1-31, Nov 1-30, and Dec 1-31.",
    }
  )

  assert.equal(grade.pass, true)
  assert.equal(grade.score, grade.maxScore)
})

test("finance fixture eval suite establishes a passing internal baseline", async () => {
  const result = await runFixtureEval({
    inputPath: path.join(cwd, "evals/finance/tasks/internal.jsonl"),
  })

  assert.equal(result.summary.tasks, 2)
  assert.equal(result.summary.failed, 0)
  assert.equal(result.summary.passRate, 1)
})

test("finance live eval output captures values, artifacts, latency, and cost metadata", () => {
  const startedAt = Date.now() - 25
  const output = buildLiveFinanceEvalOutput({
    task: {
      expectedNumbers: [
        { key: "grossMargin", value: 0.43 },
        { key: "operatingMargin", value: 0.21 },
      ],
    },
    text: "Computed values: gross margin was 43.0% and operating margin was 21.0%.",
    toolCalls: [
      {
        toolName: "code_execution",
        artifactManifest: [{ path: "finance_model.xlsx", sizeBytes: 1024 }],
      },
    ],
    sources: [{ url: "https://www.sec.gov", title: "SEC" }],
    startedAt,
    model: "moonshotai/kimi-k2.6",
  })

  assert.equal(output.values.grossMargin, 0.43)
  assert.equal(output.values.operatingMargin, 0.21)
  assert.deepEqual(output.artifacts, [
    { path: "finance_model.xlsx", sizeBytes: 1024 },
  ])
  assert.equal(output.cost.model, "moonshotai/kimi-k2.6")
  assert.equal(output.cost.estimatedUsd, null)
  assert.equal(output.latencyMs >= 0, true)
})

test("finance live eval numeric extractor preserves plain values", () => {
  assert.deepEqual(
    extractExpectedNumericValues(
      {
        expectedNumbers: [{ key: "latestCpi", value: 3.2 }],
      },
      "The latest CPI reading was 3.2, down from the prior observation."
    ),
    { latestCpi: 3.2 }
  )
})

test("GDPval judge uses AI Gateway with Kimi by default", async () => {
  const source = await readFile(
    path.join(cwd, "evals/finance/judge-gdpval-gateway.mjs"),
    "utf8"
  )

  assert.match(source, /process\.env\.AI_GATEWAY_API_KEY/)
  assert.match(source, /AvailableModels\.MOONSHOTAI_KIMI_K2_6/)
  assert.doesNotMatch(source, /process\.env\.OPENAI_API_KEY/)
  assert.doesNotMatch(source, /OPENAI_EVAL_JUDGE_MODEL/)
})
