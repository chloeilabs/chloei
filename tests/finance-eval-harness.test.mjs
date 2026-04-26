import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const harnessUrl = pathToFileURL(
  path.join(cwd, "evals/finance/harness.mjs")
).href

const { gradeFinanceOutput, runFixtureEval } = await import(harnessUrl)

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
      text: "The gross margin calculation is complete. [FMP](https://example.com)",
      toolCalls: [{ toolName: "finance_data" }, { toolName: "code_execution" }],
      values: { grossMargin: 0.431 },
      artifacts: [{ path: "finance_model.xlsx", sizeBytes: 1024 }],
    }
  )

  assert.equal(grade.pass, true)
  assert.equal(grade.score, grade.maxScore)
})

test("finance fixture eval suite establishes a passing internal baseline", async () => {
  const result = await runFixtureEval({
    inputPath: path.join(cwd, "evals/finance/tasks/internal.jsonl"),
  })

  assert.equal(result.summary.tasks, 3)
  assert.equal(result.summary.failed, 0)
  assert.equal(result.summary.passRate, 1)
})
