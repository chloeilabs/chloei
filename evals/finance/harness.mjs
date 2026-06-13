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
      values: {},
    }
  }

  return {
    text: normalizeText(output?.text),
    toolCalls: Array.isArray(output?.toolCalls) ? output.toolCalls : [],
    sources: Array.isArray(output?.sources) ? output.sources : [],
    artifacts: Array.isArray(output?.artifacts) ? output.artifacts : [],
    values:
      output?.values && typeof output.values === "object" ? output.values : {},
  }
}

function countMarkdownLinks(text) {
  return [...text.matchAll(/\[[^\]]+\]\(<?(https?:\/\/[^)>"]+)/g)].length
}

const TERM_ALIASES = new Map([
  ["january", ["jan", "jan."]],
  ["february", ["feb", "feb."]],
  ["march", ["mar", "mar."]],
  ["april", ["apr", "apr."]],
  ["may", ["may."]],
  ["june", ["jun", "jun."]],
  ["july", ["jul", "jul."]],
  ["august", ["aug", "aug."]],
  ["september", ["sep", "sept", "sep.", "sept."]],
  ["october", ["oct", "oct."]],
  ["november", ["nov", "nov."]],
  ["december", ["dec", "dec."]],
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function includesAlias(text, alias) {
  return new RegExp(`(^|[^a-z])${escapeRegExp(alias)}([^a-z]|$)`, "i").test(
    text
  )
}

function includesTerm(text, term) {
  const normalizedTerm = String(term).toLowerCase()
  const normalizedText = text.toLowerCase()
  if (normalizedText.includes(normalizedTerm)) {
    return true
  }

  return (TERM_ALIASES.get(normalizedTerm) ?? []).some((alias) =>
    includesAlias(text, alias)
  )
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

function parseNumberToken(value) {
  const normalized = String(value ?? "")
    .replace(/[$,]/g, "")
    .trim()
  if (!normalized) {
    return null
  }

  const isPercent = normalized.endsWith("%")
  const parsed = Number.parseFloat(normalized.replace(/%$/, ""))
  if (!Number.isFinite(parsed)) {
    return null
  }

  return isPercent ? parsed / 100 : parsed
}

function getKeyTerms(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/g)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
}

export function extractExpectedNumericValues(task, text) {
  const values = {}
  const normalizedText = normalizeText(text)
  for (const expectation of task.expectedNumbers ?? []) {
    const key = expectation.key
    const terms = getKeyTerms(key)
    if (terms.length === 0) {
      continue
    }

    const numberPattern = /[-+]?\$?[\d,]+(?:\.\d+)?%?/g
    let bestCandidate = null
    for (const match of normalizedText.matchAll(numberPattern)) {
      const index = match.index ?? 0
      const before = normalizedText
        .slice(Math.max(0, index - 120), index)
        .toLowerCase()
      const after = normalizedText
        .slice(index + match[0].length, index + match[0].length + 40)
        .toLowerCase()
      const context = `${before} ${after}`
      if (!terms.every((term) => context.includes(term))) {
        continue
      }

      const parsedValue = parseNumberToken(match[0])
      if (parsedValue === null) {
        continue
      }

      const beforeHasAllTerms = terms.every((term) => before.includes(term))
      const afterHasAllTerms = terms.every((term) => after.includes(term))
      const furthestBeforeDistance = Math.max(
        ...terms.map((term) => {
          const termIndex = before.lastIndexOf(term)
          return termIndex >= 0 ? before.length - termIndex : 120
        })
      )
      const nearestAfterDistance = Math.min(
        ...terms.map((term) => {
          const termIndex = after.indexOf(term)
          return termIndex >= 0 ? termIndex : 40
        })
      )
      const score =
        (beforeHasAllTerms ? 1_000 : 0) +
        (afterHasAllTerms ? 500 : 0) -
        (beforeHasAllTerms ? furthestBeforeDistance : nearestAfterDistance)

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          value: parsedValue,
          score,
        }
      }
    }

    if (bestCandidate) {
      values[key] = bestCandidate.value
    }
  }

  return values
}

function mergeArtifactManifests(toolCalls) {
  const artifactsByPath = new Map()
  for (const call of toolCalls) {
    for (const artifact of call.artifactManifest ?? []) {
      const artifactPath = String(artifact?.path ?? "")
      if (!artifactPath) {
        continue
      }

      const current = artifactsByPath.get(artifactPath)
      if (!current || (artifact.sizeBytes ?? 0) > (current.sizeBytes ?? 0)) {
        artifactsByPath.set(artifactPath, artifact)
      }
    }
  }

  return [...artifactsByPath.values()]
}

export function buildLiveFinanceEvalOutput({
  task,
  text,
  toolCalls,
  sources,
  startedAt,
  model,
}) {
  const artifacts = mergeArtifactManifests(toolCalls)
  const latencyMs = Date.now() - startedAt

  return {
    text: normalizeText(text),
    toolCalls,
    sources,
    values: extractExpectedNumericValues(task, text),
    artifacts,
    latencyMs,
    cost: {
      model,
      estimatedUsd: null,
    },
  }
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
    const value = getNumericValue(output, numericExpectation.key)
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

function gradeIncompleteFinanceRun(task, outputCandidate) {
  const grade = gradeFinanceOutput(task, outputCandidate)
  return {
    ...grade,
    score: 0,
    maxScore: grade.maxScore + 1,
    pass: false,
    checks: [
      ...grade.checks.map((check) => ({ ...check, passed: false })),
      {
        id: "run_status",
        passed: false,
        score: 1,
      },
    ],
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

export async function runLiveEval(params) {
  const tasks = await loadJsonl(params.inputPath)
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("Missing AI_GATEWAY_API_KEY for live finance eval mode.")
  }

  await import("./register-ts-hooks.mjs")
  const { startAgentRuntimeStream } =
    await import("../../src/lib/server/llm/agent-runtime.ts")
  const { buildAgentSystemInstruction } =
    await import("../../src/lib/server/agent-context.ts")
  const { resolvePromptProvider } =
    await import("../../src/lib/server/agent-prompt-steering.ts")
  const { resolveFinancialServicesWorkflow } =
    await import("../../src/lib/server/financial-services-workflows.ts")
  const { withAiSdkInlineCitationInstruction } =
    await import("../../src/lib/server/llm/system-instruction-augmentations.ts")

  const model = params.model ?? "moonshotai/kimi-k2.6"
  const limit = Math.max(
    1,
    Math.min(tasks.length, params.limit ?? tasks.length)
  )
  const selectedTasks = tasks.slice(
    params.offset ?? 0,
    (params.offset ?? 0) + limit
  )
  const results = []

  for (const task of selectedTasks) {
    const startedAt = Date.now()
    const messages = [{ role: "user", content: task.prompt }]
    const provider = resolvePromptProvider(model)
    const financialServicesWorkflow = resolveFinancialServicesWorkflow({
      messages,
      taskMode: "finance_analysis",
      tools: {
        tavilyEnabled: Boolean(process.env.TAVILY_API_KEY?.trim()),
        fredEnabled: Boolean(process.env.FRED_API_KEY?.trim()),
        secUserAgentConfigured: Boolean(process.env.SEC_API_USER_AGENT?.trim()),
      },
    })
    const systemInstruction = withAiSdkInlineCitationInstruction(
      buildAgentSystemInstruction(
        {
          id: "finance-eval-runner",
          name: "Chloei Finance Eval Runner",
          email: "eval@example.com",
        },
        {
          now: new Date(),
          userTimeZone: params.userTimeZone,
          provider,
          taskMode: "finance_analysis",
          ...(financialServicesWorkflow ? { financialServicesWorkflow } : {}),
        }
      ),
      {
        secFilingsEnabled: true,
      }
    )
    const toolCalls = []
    const toolCallsById = new Map()
    const sources = []
    let text = ""
    let status = "completed"
    let error

    try {
      const signal = AbortSignal.timeout(params.taskTimeoutMs ?? 180_000)
      for await (const event of startAgentRuntimeStream({
        model,
        aiGatewayApiKey: apiKey,
        tavilyApiKey: process.env.TAVILY_API_KEY,
        fredApiKey: process.env.FRED_API_KEY,
        secUserAgent: process.env.SEC_API_USER_AGENT,
        userTimeZone: params.userTimeZone,
        runtimeProfile: "finance_analysis",
        messages,
        systemInstruction,
        signal,
      })) {
        if (event.type === "text_delta") {
          text += event.delta
          continue
        }

        if (event.type === "source") {
          sources.push(event.source)
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
          if (!call) {
            continue
          }
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
          if (event.artifactManifest) {
            call.artifactManifest = event.artifactManifest
          }
        }
      }
    } catch (caught) {
      status = "failed"
      error = caught instanceof Error ? caught.message : String(caught)
    }

    const output = buildLiveFinanceEvalOutput({
      task,
      text,
      toolCalls,
      sources,
      startedAt,
      model,
    })

    const grade =
      status === "completed"
        ? gradeFinanceOutput(task, output)
        : gradeIncompleteFinanceRun(task, output)

    results.push({
      taskId: task.id,
      category: task.category,
      status,
      ...(error ? { error } : {}),
      output,
      grade,
    })
  }

  return {
    mode: "live",
    inputPath: params.inputPath,
    generatedAt: new Date().toISOString(),
    model,
    runtimeProfile: "finance_analysis",
    summary: summarizeResults(results),
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
