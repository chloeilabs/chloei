import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const harnessUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-harness.ts")
).href
const routerUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/finance-tool-router.ts")
).href
const ledgerUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/evidence-ledger.ts")
).href
const investmentMathUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/investment-memo-math.ts")
).href
const curatedToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/curated-finance-tools.ts")
).href
const codeExecutionPath = path.join(
  cwd,
  "src/lib/server/llm/code-execution-tools.ts"
)

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const { createAgentHarnessRun, createHarnessTraceEvents, getHarnessPromptContext } =
  await import(harnessUrl)
const { routeCuratedFinanceRequest } = await import(routerUrl)
const {
  addEvidence,
  createEvidenceLedger,
  verifyInvestmentMemoRequirements,
} = await import(ledgerUrl)
const { createAiSdkCuratedFinanceTools } = await import(curatedToolsUrl)
const {
  calculateDcfScenario,
  calculateProbabilityWeightedExpectedValue,
} = await import(investmentMathUrl)

test("agent harness classifies finance and research plans", () => {
  const run = createAgentHarnessRun({
    requestId: "request-1",
    model: "openai/gpt-5.5",
    messages: [
      {
        role: "user",
        content:
          "Build an investment memo for AAPL using valuation, catalysts, filings, and risks.",
      },
    ],
    userTimeZone: "America/Chicago",
  })

  assert.equal(run.profile, "investment_memo")
  assert.equal(run.plan.riskLevel, "medium")
  assert.equal(run.budgets.maxToolCalls > 12, true)
  assert.equal(run.budgets.maxVerificationChecks >= 8, true)
  assert.deepEqual(run.plan.candidateTools.includes("curated_finance"), true)
  assert.match(run.plan.requiredEvidence.join("\n"), /reverse DCF/)
  assert.match(run.plan.requiredEvidence.join("\n"), /GAAP vs non-GAAP EPS/)
  assert.match(run.plan.requiredEvidence.join("\n"), /hyperscaler AI capex/)
  assert.match(run.plan.requiredEvidence.join("\n"), /primary-source hyperscaler capex/)
  assert.match(run.plan.requiredEvidence.join("\n"), /China\/export-control/)
  assert.match(run.plan.requiredEvidence.join("\n"), /DCF sensitivity matrix/)
  assert.match(run.plan.requiredEvidence.join("\n"), /code-verified DCF math/)
  assert.match(run.plan.requiredEvidence.join("\n"), /probability-weighted expected value/)
  assert.match(run.plan.requiredEvidence.join("\n"), /falsification triggers/)
  assert.match(run.plan.requiredEvidence.join("\n"), /bear\/base\/bull/)
  assert.match(getHarnessPromptContext(run), /reverse-DCF or scenario math/)
  assert.match(getHarnessPromptContext(run), /Institutional Memo Checklist/)
  assert.match(getHarnessPromptContext(run), /customer concentration/)
  assert.match(getHarnessPromptContext(run), /buy\/hold\/trim zones/)
  assert.match(getHarnessPromptContext(run), /probability-weighted expected value/)
  assert.match(getHarnessPromptContext(run), /named model was trained/)
  assert.equal(createHarnessTraceEvents(run).length, 2)
})

test("agent harness avoids code execution guidance for text-tool models", () => {
  const run = createAgentHarnessRun({
    model: "deepseek/deepseek-v4-pro",
    messages: [
      {
        role: "user",
        content: "Build an investment memo for NVDA with valuation scenarios.",
      },
    ],
  })

  assert.equal(run.profile, "investment_memo")
  assert.equal(run.plan.candidateTools.includes("curated_finance"), true)
  assert.equal(run.plan.candidateTools.includes("code_execution"), false)
})

test("finance router prefers paid FMP and official fallbacks", () => {
  const marketRoute = routeCuratedFinanceRequest({
    operation: "market_data",
    capabilities: { fmpConfigured: true },
  })
  assert.equal(marketRoute.primaryProvider, "fmp")
  assert.deepEqual(marketRoute.fallbackProviders.slice(0, 1), ["stooq"])

  const filingRoute = routeCuratedFinanceRequest({
    operation: "filing_facts",
  })
  assert.equal(filingRoute.primaryProvider, "sec")
  assert.equal(filingRoute.sourcePolicy, "official")

  const macroRoute = routeCuratedFinanceRequest({
    operation: "macro_series",
    capabilities: { fredConfigured: true },
  })
  assert.equal(macroRoute.primaryProvider, "fred")
  assert.equal(macroRoute.fallbackProviders.includes("treasury"), true)
})

test("evidence ledger tracks sources and verification gaps", () => {
  const ledger = addEvidence(createEvidenceLedger(), {
    kind: "market_data",
    provider: "fmp",
    operation: "quote",
    title: "AAPL quote",
    summary: "FMP quote response.",
    confidence: "high",
    source: {
      id: "fmp-quote",
      title: "Financial Modeling Prep",
      url: "https://financialmodelingprep.com/",
    },
    reportedValues: { price: 280 },
  })

  assert.equal(ledger.evidence.length, 1)
  assert.equal(ledger.sources.length, 1)
  assert.equal(ledger.verification.status, "verified")
})

test("investment memo verifier requires primary capex rebuild and expected value", () => {
  const partial = verifyInvestmentMemoRequirements({
    hasDcfSensitivityMatrix: true,
    hasCodeVerifiedDcfMath: false,
    hasProbabilityWeightedExpectedValue: false,
    hasPrimarySourceCapexRebuild: false,
    hasChinaExportSizing: true,
    labelsEstimatedCustomerExposure: false,
    softensUnverifiedAiChipClaims: false,
    rejectsUnsupportedSecondaryCatalysts: true,
  })

  assert.equal(partial.status, "partial")
  assert.match(partial.gaps.join("\n"), /hyperscaler capex/)
  assert.match(partial.gaps.join("\n"), /DCF and scenario math/)
  assert.match(partial.gaps.join("\n"), /probability-weighted expected value/)
  assert.match(partial.gaps.join("\n"), /customer exposure estimates/)
  assert.match(partial.gaps.join("\n"), /named model training/)

  const verified = verifyInvestmentMemoRequirements({
    hasDcfSensitivityMatrix: true,
    hasCodeVerifiedDcfMath: true,
    hasProbabilityWeightedExpectedValue: true,
    hasPrimarySourceCapexRebuild: true,
    hasChinaExportSizing: true,
    labelsEstimatedCustomerExposure: true,
    softensUnverifiedAiChipClaims: true,
    rejectsUnsupportedSecondaryCatalysts: true,
  })

  assert.equal(verified.status, "verified")
})

test("investment memo math calculates DCF and expected value", () => {
  const dcf = calculateDcfScenario({
    startingFcf: 96.7,
    fcfCagr: 0.2,
    years: 10,
    wacc: 0.1,
    terminalGrowth: 0.03,
    netCash: 54,
    dilutedShares: 24.3,
  })

  assert.equal(Math.round(dcf.enterpriseValue), 5006)
  assert.equal(Math.round(dcf.impliedPrice ?? 0), 208)
  assert.equal(
    calculateProbabilityWeightedExpectedValue([
      { probability: 0.3, price: 120 },
      { probability: 0.5, price: 180 },
      { probability: 0.2, price: 280 },
    ]),
    182
  )
})

test("curated finance tool routes market data through FMP when configured", async () => {
  const tools = createAiSdkCuratedFinanceTools({
    fmpApiKey: "secret-key",
    fetchImpl: async (url) => {
      const requestUrl = String(url)
      assert.match(requestUrl, /financialmodelingprep\.com/)
      return new Response(JSON.stringify([{ symbol: "AAPL", price: 280 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })

  const result = await tools.curated_finance.execute({
    operation: "market_data",
    symbol: "AAPL",
  })

  assert.equal(result.route.primaryProvider, "fmp")
  assert.equal(result.result.output?.provider, "fmp")
  assert.equal(result.ledger.evidence[0]?.provider, "fmp")
})

test("code execution includes Vercel Sandbox backend integration", async () => {
  const source = await readFile(codeExecutionPath, "utf8")

  assert.match(source, /@vercel\/sandbox/)
  assert.match(source, /vercel_sandbox/)
  assert.match(source, /networkPolicy: getVercelSandboxNetworkPolicy/)
  assert.match(source, /AGENT_CODE_EXECUTION_VERCEL_SANDBOX_SNAPSHOT_ID/)
})
