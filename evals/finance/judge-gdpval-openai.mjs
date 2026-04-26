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

function getOutputText(response) {
  const parts = []

  for (const item of response.output ?? []) {
    if (item.type !== "message") {
      continue
    }

    for (const content of item.content ?? []) {
      if (content.type === "output_text") {
        parts.push(content.text)
      }
    }
  }

  return parts.join("\n").trim()
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

async function createResponse(payload) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${text}`)
  }

  return JSON.parse(text)
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isUnsupportedFileError(errorMessage) {
  return /unsupported_file|file type you uploaded is not supported/i.test(
    errorMessage
  )
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

function buildJudgeInput(
  task,
  {
    attachmentNote,
    candidateContextMaxChars,
    candidateOutput,
    includeFiles,
    mode,
    normalizedContextText,
  }
) {
  const content = [
    {
      type: "input_text",
      text: [
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
          ? "The candidate is the public GDPval gold deliverable attached or linked below. This validates the judge path, not Chloei model performance."
          : "Use the candidate output attached or described below.",
        attachmentNote ? `\nAttachment note: ${attachmentNote}` : "",
        normalizedContextText
          ? "\nNormalized file context is included below. Treat it as extracted evidence from the GDPval reference and deliverable files; reflect any extraction truncation or limitation in file_access/confidence."
          : "",
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
      ].join("\n"),
    },
  ]

  if (normalizedContextText) {
    content.push({
      type: "input_text",
      text: normalizedContextText,
    })
  }

  if (mode !== "gold_sanity") {
    content.push({
      type: "input_text",
      text: formatCandidateOutput(candidateOutput, candidateContextMaxChars),
    })
  }

  if (!includeFiles) {
    content.push({
      type: "input_text",
      text: [
        "Reference file URLs:",
        ...(task.reference_file_urls ?? []),
        "",
        "Gold/candidate deliverable file URLs:",
        ...(task.deliverable_file_urls ?? []),
      ].join("\n"),
    })
    return content
  }

  for (const url of task.reference_file_urls ?? []) {
    content.push({
      type: "input_file",
      file_url: url,
    })
  }

  for (const url of task.deliverable_file_urls ?? []) {
    content.push({
      type: "input_file",
      file_url: url,
    })
  }

  return content
}

function buildInput(
  task,
  {
    attachmentNote,
    candidateContextMaxChars,
    candidateOutput,
    includeFiles,
    mode,
    normalizedContextText,
  }
) {
  return [
    {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: [
            "You are an exacting GDPval-style evaluator.",
            "Assess deliverables against the provided rubric.",
            "Do not invent file contents. If attached files cannot be inspected, set file_access accordingly and lower confidence.",
            "Return JSON only.",
          ].join(" "),
        },
      ],
    },
    {
      role: "user",
      content: buildJudgeInput(task, {
        attachmentNote,
        candidateContextMaxChars,
        candidateOutput,
        includeFiles,
        mode,
        normalizedContextText,
      }),
    },
  ]
}

async function runJudge(
  task,
  {
    attachmentNote,
    candidateContextMaxChars,
    candidateOutput,
    includeFiles,
    normalizedContextText,
  }
) {
  const response = await createResponse({
    model,
    reasoning: { effort },
    max_output_tokens: maxOutputTokens,
    input: buildInput(task, {
      attachmentNote,
      candidateContextMaxChars,
      candidateOutput,
      includeFiles,
      mode,
      normalizedContextText,
    }),
  })
  const text = getOutputText(response)

  return {
    response,
    text,
    parsed: parseJudgeJson(text),
  }
}

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY.")
}

const manifestPath = path.resolve(
  repoRoot,
  getArg("--manifest", "evals/finance/results/gdpval-finance-manifest.json")
)
const outputPath = path.resolve(
  repoRoot,
  getArg(
    "--output",
    `evals/finance/results/gdpval-openai-judge-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  )
)
const model = getArg(
  "--model",
  process.env.OPENAI_EVAL_JUDGE_MODEL ?? "gpt-5.4-mini"
)
const effort = getArg("--reasoning-effort", "xhigh")
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
    effort,
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
    if (includeFiles && isUnsupportedFileError(errorMessage)) {
      try {
        const run = await runJudge(task, {
          attachmentNote:
            "Direct file attachment was rejected by the OpenAI API as unsupported, so this fallback pass only includes file URLs. Treat file contents as unavailable unless visible in the URLs or prompt metadata.",
          candidateContextMaxChars,
          candidateOutput: candidateOutputs.get(task.task_id),
          includeFiles: false,
          normalizedContextText,
        })
        pushCompletedResult(task, startedAt, run, "unsupported_file_url_only")
        await writeCheckpoint()
        continue
      } catch (fallbackError) {
        results.push({
          taskId: task.task_id,
          sector: task.sector,
          occupation: task.occupation,
          mode,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: getErrorMessage(fallbackError),
          primaryError: errorMessage,
        })
        await writeCheckpoint()
        continue
      }
    }

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
            "Skipped because the OpenAI API reported insufficient_quota earlier in this batch.",
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
console.log(JSON.stringify({ outputPath, summary: result.summary }, null, 2))

if (result.summary.failed > 0) {
  process.exitCode = 1
}
