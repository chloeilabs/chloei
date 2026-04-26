import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export async function loadJsonl(filePath) {
  const source = await readFile(filePath, "utf8")
  return source
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

function toOutputRecord(output) {
  if (typeof output === "string") {
    return {
      text: output,
      toolCalls: [],
      sources: [],
      artifacts: [],
    }
  }

  return {
    text: normalizeText(output?.text),
    toolCalls: Array.isArray(output?.toolCalls) ? output.toolCalls : [],
    sources: Array.isArray(output?.sources) ? output.sources : [],
    artifacts: Array.isArray(output?.artifacts) ? output.artifacts : [],
  }
}

function countMarkdownLinks(text) {
  return [...text.matchAll(/\[[^\]]+\]\(<?(https?:\/\/[^)>"]+)/g)].length
}

function includesTerm(text, term) {
  return text.toLowerCase().includes(String(term).toLowerCase())
}

function hasRequiredTool(toolCalls, toolName) {
  return toolCalls.some((call) => call?.toolName === toolName)
}

function hasRequiredArtifact(artifacts, requirement) {
  return artifacts.some((artifact) => {
    const artifactPath = String(artifact?.path ?? artifact?.name ?? "")
    if (!artifactPath) {
      return false
    }

    if (
      requirement.nameIncludes &&
      !includesTerm(artifactPath, requirement.nameIncludes)
    ) {
      return false
    }

    if (
      requirement.extension &&
      !artifactPath.endsWith(requirement.extension)
    ) {
      return false
    }

    return true
  })
}

function getNumericValue(output, key) {
  const values = output.values
  if (!values || typeof values !== "object") {
    return null
  }

  const value = values[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function gradeFinanceOutput(task, outputCandidate) {
  const output = toOutputRecord(outputCandidate)
  const checks = []

  for (const term of task.expectedTerms ?? []) {
    checks.push({
      id: `term:${term}`,
      passed: includesTerm(output.text, term),
      score: 1,
    })
  }

  for (const toolName of task.requiredTools ?? []) {
    checks.push({
      id: `tool:${toolName}`,
      passed: hasRequiredTool(output.toolCalls, toolName),
      score: 2,
    })
  }

  const minCitations = task.minCitations ?? 0
  if (minCitations > 0) {
    const citationCount =
      output.sources.length + countMarkdownLinks(output.text)
    checks.push({
      id: "citations",
      passed: citationCount >= minCitations,
      score: minCitations,
    })
  }

  for (const artifactRequirement of task.requiredArtifacts ?? []) {
    checks.push({
      id: `artifact:${artifactRequirement.nameIncludes ?? artifactRequirement.extension}`,
      passed: hasRequiredArtifact(output.artifacts, artifactRequirement),
      score: artifactRequirement.score ?? 2,
    })
  }

  for (const numericExpectation of task.expectedNumbers ?? []) {
    const value = getNumericValue(outputCandidate, numericExpectation.key)
    const tolerance = numericExpectation.tolerance ?? 0
    checks.push({
      id: `number:${numericExpectation.key}`,
      passed:
        value !== null &&
        Math.abs(value - numericExpectation.value) <= tolerance,
      score: numericExpectation.score ?? 2,
    })
  }

  const maxScore = checks.reduce((total, check) => total + check.score, 0)
  const score = checks.reduce(
    (total, check) => total + (check.passed ? check.score : 0),
    0
  )

  return {
    taskId: task.id,
    score,
    maxScore,
    pass: maxScore === 0 ? true : score / maxScore >= (task.passRate ?? 0.8),
    checks,
  }
}

export async function runFixtureEval(params) {
  const tasks = await loadJsonl(params.inputPath)
  const results = tasks.map((task) => {
    const output = task.fixtureOutput ?? {
      text: "",
      toolCalls: [],
      sources: [],
      artifacts: [],
    }

    return {
      taskId: task.id,
      category: task.category,
      output,
      grade: gradeFinanceOutput(task, output),
    }
  })

  const summary = summarizeResults(results)
  return {
    mode: "fixture",
    inputPath: params.inputPath,
    generatedAt: new Date().toISOString(),
    summary,
    results,
  }
}

export function summarizeResults(results) {
  const maxScore = results.reduce(
    (total, result) => total + result.grade.maxScore,
    0
  )
  const score = results.reduce((total, result) => total + result.grade.score, 0)
  const passed = results.filter((result) => result.grade.pass).length

  return {
    tasks: results.length,
    passed,
    failed: results.length - passed,
    score,
    maxScore,
    scoreRate: maxScore > 0 ? score / maxScore : 1,
    passRate: results.length > 0 ? passed / results.length : 1,
  }
}

export async function writeEvalResult(result, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
}
