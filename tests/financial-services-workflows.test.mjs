import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const workflowsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/financial-services-workflows.ts")
).href

const { resolveFinancialServicesWorkflow } = await import(workflowsUrl)

test("financial services workflow detection selects modeling skills", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content: "Build a DCF model and trading comps workbook for AAPL.",
      },
    ],
    taskMode: "finance_analysis",
  })

  assert.equal(context?.workflow, "financial_modeling")
  assert.deepEqual(context?.skillIds, [
    "model-builder",
    "dcf-model",
    "comps-analysis",
    "audit-xls",
    "xlsx-author",
  ])
  assert.match(context?.promptBlock ?? "", /Skill: dcf-model/)
  assert.doesNotMatch(context?.promptBlock ?? "", /Skill: pitch-materials/)
})

test("financial services workflow detection selects modeling for workbook artifacts", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content:
          "Create a minimal finance workbook artifact named smoke_model.xlsx.",
      },
    ],
    taskMode: "general",
  })

  assert.equal(context?.workflow, "financial_modeling")
  assert.match(context?.promptBlock ?? "", /Skill: xlsx-author/)
})

test("financial services workflow detection ignores non-finance generic model prompts", () => {
  assert.equal(
    resolveFinancialServicesWorkflow({
      messages: [
        {
          role: "user",
          content: "Build a model in Python to classify images.",
        },
      ],
      taskMode: "coding",
    }),
    null
  )

  assert.equal(
    resolveFinancialServicesWorkflow({
      messages: [
        {
          role: "user",
          content: "Create a workbook to track my workout plan.",
        },
      ],
      taskMode: "general",
    }),
    null
  )
})

test("financial services workflow detection selects market research", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content: "Create a sector overview and competitive landscape.",
      },
    ],
    taskMode: "research",
    tools: {
      tavilyEnabled: true,
    },
  })

  assert.equal(context?.workflow, "market_research")
  assert.deepEqual(context?.skillIds, ["market-researcher"])
  assert.match(context?.promptBlock ?? "", /Tavily API key: configured/)
})

test("financial services workflow detection selects filing research for Vals-style retrieval", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content:
          "Calculate the % change in total common stock shares repurchased from the latest Netflix 10-K filing table versus the prior year.",
      },
    ],
    taskMode: "finance_analysis",
    tools: {
      secUserAgentConfigured: true,
    },
  })

  assert.equal(context?.workflow, "filing_research")
  assert.deepEqual(context?.skillIds, [
    "filing-researcher",
    "sec-table-extractor",
    "evidence-auditor",
  ])
  assert.match(context?.promptBlock ?? "", /Skill: filing-researcher/)
  assert.match(context?.promptBlock ?? "", /use sec_filings/i)
})

test("financial services workflow detection selects earnings review", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content:
          "How did Lam Research revenue compare to management guidance at the midpoint for each 2024 earnings quarter?",
      },
    ],
    taskMode: "finance_analysis",
  })

  assert.equal(context?.workflow, "earnings_review")
  assert.match(context?.promptBlock ?? "", /Skill: earnings-reviewer/)
  assert.match(context?.promptBlock ?? "", /Skill: evidence-auditor/)
})

test("financial services workflow detection does not route generic guidance to earnings review", () => {
  const modelingContext = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content: "I need guidance on structuring this DCF model for MSFT.",
      },
    ],
    taskMode: "finance_analysis",
  })

  assert.equal(modelingContext?.workflow, "financial_modeling")

  const filingContext = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content: "Find the 10-K section on SEC guidance for Microsoft.",
      },
    ],
    taskMode: "finance_analysis",
    tools: {
      secUserAgentConfigured: true,
    },
  })

  assert.equal(filingContext?.workflow, "filing_research")
})

test("financial services workflow detection selects pitch materials first", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content:
          "Write a pitch deck outline with a football field valuation summary.",
      },
    ],
    taskMode: "finance_analysis",
  })

  assert.equal(context?.workflow, "pitch_materials")
  assert.match(context?.promptBlock ?? "", /Skill: pitch-materials/)
  assert.match(context?.promptBlock ?? "", /Skill: comps-analysis/)
})

test("financial services workflow detection does not override personal advice safety", () => {
  const context = resolveFinancialServicesWorkflow({
    messages: [
      {
        role: "user",
        content: "Should I buy this stock in my retirement account?",
      },
    ],
    taskMode: "high_stakes",
  })

  assert.equal(context, null)
})
