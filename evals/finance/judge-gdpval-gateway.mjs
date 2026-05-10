#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createGateway } from "@ai-sdk/gateway"
import { generateText } from "ai"

import { writeEvalResult } from "./harness.mjs"

await import("./register-ts-hooks.mjs")

const { createLogger } = await import("@/lib/logger")
const { aiGatewayFetch } = await import("@/lib/server/llm/gateway-client")
const { AvailableModels } = await import("@/lib/shared/llm/models")

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(evalDir, "../..")
const logger = createLogger("evals/finance/judge-gdpval-gateway")
const DEFAULT_JUDGE_MODEL = AvailableModels.MOONSHOTAI_KIMI_K2_6
const JUDGE_SYSTEM_PROMPT = [
  "You are an exacting GDPval-style evaluator.",
  "Assess deliverables against the provided rubric.",
  "Do not invent file contents.",
  "The judge runs through AI Gateway without a browsing tool or direct file upload.",
  "Use only the prompt text, normalized file context, candidate output, and file URL metadata provided.",
  "Return JSON only.",
].join(" ")

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

function parseJudgeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = /\{[\s\S]*\}/.exec(text)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        try {
          return JSON.parse(
            match[0].replace(/("met"\s*:\s*)partial\b/g, "$1false")
          )
        } catch {
          return null
        }
      }
    }

    return null
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isInsufficientQuotaError(errorMessage) {
  return /insufficient_quota|exceeded your current quota/i.test(errorMessage)
}

function trimToBudget(text, budget) {
  if (!text || text.length <= budget) {
    return text
  }

  return `${text.slice(0, budget)}\n\n[TRUNCATED: kept ${budget} of ${text.length} characters]`
}

function formatCandidateOutput(candidateResult, maxChars) {
  if (!candidateResult) {
    return "[Candidate output missing for this task.]"
  }

  const output = candidateResult.output ?? {}
  const sections = [
    "# Candidate Output",
    `Task ID: ${candidateResult.taskId}`,
    `Candidate status: ${candidateResult.status}`,
    `Duration ms: ${candidateResult.durationMs ?? "unknown"}`,
    candidateResult.error ? `Error: ${candidateResult.error}` : null,
    "",
    "## Final Answer Text",
    output.text?.trim() || "[No final text]",
    "",
    "## Tool Calls",
    JSON.stringify(output.toolCalls ?? [], null, 2),
    "",
    "## Sources",
    JSON.stringify(output.sources ?? [], null, 2),
    "",
    "## Artifact Manifest",
    JSON.stringify(output.artifacts ?? [], null, 2),
  ].filter((section) => section !== null)

  for (const artifactContext of output.artifactContexts ?? []) {
    sections.push(
      "",
      `## Generated Artifact Context: ${artifactContext.path}`,
      `Kind: ${artifactContext.kind}; extraction status: ${artifactContext.status}; truncated: ${artifactContext.truncated}`,
      artifactContext.warnings?.length
        ? `Warnings: ${artifactContext.warnings.join("; ")}`
        : "Warnings: none",
      "",
      artifactContext.text || "[No extracted artifact text]"
    )
  }

  return trimToBudget(sections.join("\n"), maxChars)
}

function formatUrls(title, urls) {
  const normalizedUrls = urls.filter(Boolean)
  if (normalizedUrls.length === 0) {
    return `${title}: none`
  }

  return [title, ...normalizedUrls.map((url) => `- ${url}`)].join("\n")
}

function buildFileUrlSection(task, includeFiles, mode) {
  if (!includeFiles) {
    return "File URL metadata omitted by --no-files."
  }

  const sections = [
    "File URL metadata only. These URLs are not fetched by the judge unless their contents are also present in normalized file context.",
    formatUrls("Reference file URLs", task.reference_file_urls ?? []),
  ]

  if (mode === "gold_sanity") {
    sections.push(
      formatUrls("Gold deliverable file URLs", task.deliverable_file_urls ?? [])
    )
  }

  return sections.join("\n\n")
}

function buildJudgePrompt(
  task,
  {
    candidateContextMaxChars,
    candidateOutput,
    includeFiles,
    mode,
    normalizedContextText,
  }
) {
  const sections = [
    "Run a GDPval-style rubric judge pass.",
    "",
    `Mode: ${mode}`,
    `Task ID: ${task.task_id}`,
    `Sector: ${task.sector}`,
    `Occupation: ${task.occupation}`,
    "",
    "Task prompt:",
    task.prompt,
    "",
    "Rubric:",
    task.rubric_pretty,
    "",
    "Candidate deliverable:",
    mode === "gold_sanity"
      ? "The candidate is the public GDPval gold deliverable represented by the normalized context and metadata below. This validates the judge path, not Chloei model performance."
      : "Use the Chloei candidate output described below.",
    "",
    buildFileUrlSection(task, includeFiles, mode),
    "",
    normalizedContextText
      ? "Normalized file context is included below. Treat it as extracted evidence from GDPval reference and deliverable files. Reflect extraction truncation or missing content in file_access and confidence."
      : "No normalized file context was provided. Treat file contents as unavailable unless visible elsewhere in this prompt.",
    "",
    "Return only strict JSON with this shape:",
    JSON.stringify({
      task_id: task.task_id,
      mode,
      score_estimate_0_to_100: 0,
      pass: false,
      confidence_0_to_1: 0,
      file_access: "available | partial | unavailable",
      rationale: "brief rationale",
      rubric_findings: [
        {
          criterion: "rubric item summary",
          met: true,
          evidence: "brief evidence or missing evidence",
        },
      ],
    }),
  ]

  if (normalizedContextText) {
    sections.push("", "# Normalized File Context", normalizedContextText)
  }

  if (mode !== "gold_sanity") {
    sections.push(
      "",
      formatCandidateOutput(candidateOutput, candidateContextMaxChars)
    )
  }

  return sections.join("\n")
}

async function runJudge(
  task,
  {
    candidateContextMaxChars,
    candidateOutput,
    includeFiles,
    normalizedContextText,
  }
) {
  const result = await generateText({
    model: gatewayProvider(model),
    system: JUDGE_SYSTEM_PROMPT,
    prompt: buildJudgePrompt(task, {
      candidateContextMaxChars,
      candidateOutput,
      includeFiles,
      normalizedContextText,
      mode,
    }),
    maxOutputTokens,
  })
  const text = result.text.trim()

  return {
    response: {
      id: result.response.id,
      model: result.response.modelId,
      finishReason: result.finishReason,
      usage: result.totalUsage ?? result.usage ?? null,
      warnings: result.warnings ?? null,
    },
    text,
    parsed: parseJudgeJson(text),
  }
}

const apiKey = process.env.AI_GATEWAY_API_KEY
if (!apiKey) {
  throw new Error("Missing AI_GATEWAY_API_KEY.")
}
const gatewayProvider = createGateway({
  apiKey,
  fetch: aiGatewayFetch,
})

const manifestPath = path.resolve(
  repoRoot,
  getArg("--manifest", "evals/finance/results/gdpval-finance-manifest.json")
)
const outputPath = path.resolve(
  repoRoot,
  getArg(
    "--output",
    `evals/finance/results/gdpval-gateway-judge-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  )
)
const model = getArg("--model", DEFAULT_JUDGE_MODEL)
const maxOutputTokens = Number(getArg("--max-output-tokens", "8000"))
const limit = Number(getArg("--limit", "3"))
const offset = Number(getArg("--offset", "0"))
const includeFiles = !getFlag("--no-files")
const mode = getArg("--mode", "gold_sanity")
const normalizedContextDir = getArg("--normalized-context-dir", null)
const normalizedContextMaxChars = Number(
  getArg("--normalized-context-max-chars", "180000")
)
const candidateOutputPath = getArg("--candidate-output", null)
const candidateContextMaxChars = Number(
  getArg("--candidate-context-max-chars", "140000")
)

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const tasks = manifest.tasks.slice(offset, offset + limit)
const results = []
const normalizedContexts = new Map()
const candidateOutputs = new Map()

if (candidateOutputPath) {
  const candidateOutput = JSON.parse(
    await readFile(path.resolve(repoRoot, candidateOutputPath), "utf8")
  )
  for (const result of candidateOutput.results ?? []) {
    candidateOutputs.set(result.taskId, result)
  }
}

if (normalizedContextDir) {
  const contextDir = path.resolve(repoRoot, normalizedContextDir)
  for (const task of tasks) {
    try {
      const contextText = await readFile(
        path.join(contextDir, `${task.task_id}.md`),
        "utf8"
      )
      normalizedContexts.set(
        task.task_id,
        trimToBudget(contextText, normalizedContextMaxChars)
      )
    } catch (error) {
      normalizedContexts.set(
        task.task_id,
        `[Normalized file context unavailable: ${getErrorMessage(error)}]`
      )
    }
  }
}

function pushCompletedResult(task, startedAt, run, fallbackReason) {
  results.push({
    taskId: task.task_id,
    sector: task.sector,
    occupation: task.occupation,
    mode,
    status: "completed",
    durationMs: Date.now() - startedAt,
    responseId: run.response.id,
    model: run.response.model,
    rawText: run.text,
    parsed: run.parsed,
    fallbackReason,
    usage: run.response.usage ?? null,
  })
}

function buildOutput() {
  const completed = results.filter((result) => result.status === "completed")
  const skipped = results.filter((result) => result.status === "skipped")
  const parsed = completed.filter((result) => result.parsed)
  return {
    mode,
    generatedAt: new Date().toISOString(),
    manifestPath,
    source: manifest.source,
    model,
    maxOutputTokens,
    includeFiles,
    normalizedContextDir,
    normalizedContextMaxChars,
    candidateOutputPath,
    candidateContextMaxChars,
    offset,
    limit,
    checkpoint: {
      requested: tasks.length,
      attempted: results.length,
      remaining: Math.max(0, tasks.length - results.length),
    },
    summary: {
      requested: tasks.length,
      completed: completed.length,
      failed: results.length - completed.length - skipped.length,
      skipped: skipped.length,
      parsed: parsed.length,
      averageScore:
        parsed.length > 0
          ? parsed.reduce(
              (total, item) =>
                total + Number(item.parsed.score_estimate_0_to_100 ?? 0),
              0
            ) / parsed.length
          : null,
    },
    results,
  }
}

async function writeCheckpoint() {
  await writeEvalResult(buildOutput(), outputPath)
}

for (let index = 0; index < tasks.length; index += 1) {
  const task = tasks[index]
  const startedAt = Date.now()
  const normalizedContextText = normalizedContexts.get(task.task_id)
  try {
    const run = await runJudge(task, {
      candidateContextMaxChars,
      candidateOutput: candidateOutputs.get(task.task_id),
      includeFiles,
      normalizedContextText,
    })
    pushCompletedResult(task, startedAt, run)
    await writeCheckpoint()
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    results.push({
      taskId: task.task_id,
      sector: task.sector,
      occupation: task.occupation,
      mode,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: errorMessage,
    })

    if (isInsufficientQuotaError(errorMessage)) {
      for (const skippedTask of tasks.slice(index + 1)) {
        results.push({
          taskId: skippedTask.task_id,
          sector: skippedTask.sector,
          occupation: skippedTask.occupation,
          mode,
          status: "skipped",
          durationMs: 0,
          error:
            "Skipped because AI Gateway reported insufficient_quota earlier in this batch.",
        })
      }
      await writeCheckpoint()
      break
    }

    await writeCheckpoint()
  }
}

const result = buildOutput()

await writeEvalResult(result, outputPath)
logger.info("GDPval judge result written.", {
  outputPath,
  summary: result.summary,
})

if (result.summary.failed > 0) {
  process.exitCode = 1
}
