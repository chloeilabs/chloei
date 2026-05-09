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
        content: "Create a minimal workbook artifact named smoke_model.xlsx.",
      },
    ],
    taskMode: "general",
  })

  assert.equal(context?.workflow, "financial_modeling")
  assert.match(context?.promptBlock ?? "", /Skill: xlsx-author/)
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
