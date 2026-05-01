import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/finance-data/sec-company-facts.ts")
).href

const { summarizeSecCompanyFacts, summarizeSecFinancialStatement } =
  await import(moduleUrl)

function fact(value, overrides = {}) {
  return {
    units: {
      USD: [
        {
          val: value,
          fy: 2025,
          fp: "FY",
          form: "10-K",
          filed: "2025-07-30",
          start: "2024-07-01",
          end: "2025-06-30",
          ...overrides,
        },
      ],
    },
  }
}

test("SEC company facts summarize annual income statements with computed margins", () => {
  const summary = summarizeSecFinancialStatement({
    data: {
      facts: {
        "us-gaap": {
          Revenues: fact(100),
          GrossProfit: fact(60),
          OperatingIncomeLoss: fact(30),
          NetIncomeLoss: fact(20),
        },
      },
    },
    cik: "789019",
    symbol: "msft",
    statementType: "income",
    period: "annual",
  })

  assert.equal(summary.cik, "0000789019")
  assert.equal(summary.symbol, "MSFT")
  assert.equal(summary.reportedFacts.revenue.value, 100)
  assert.equal(summary.computedValues.grossMargin, 0.6)
  assert.equal(summary.computedValues.operatingMargin, 0.3)
  assert.equal(summary.computedValues.netMargin, 0.2)
})

test("SEC company facts prefer matching period facts for quarterly statements", () => {
  const summary = summarizeSecFinancialStatement({
    data: {
      facts: {
        "us-gaap": {
          NetCashProvidedByUsedInOperatingActivities: {
            units: {
              USD: [
                {
                  val: 900,
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-07-30",
                  start: "2024-07-01",
                  end: "2025-06-30",
                },
                {
                  val: 120,
                  fy: 2026,
                  fp: "Q1",
                  form: "10-Q",
                  filed: "2025-10-25",
                  start: "2025-07-01",
                  end: "2025-09-30",
                },
              ],
            },
          },
          PaymentsToAcquirePropertyPlantAndEquipment: fact(20, {
            fy: 2026,
            fp: "Q1",
            form: "10-Q",
            filed: "2025-10-25",
            start: "2025-07-01",
            end: "2025-09-30",
          }),
          Revenues: fact(400, {
            fy: 2026,
            fp: "Q1",
            form: "10-Q",
            filed: "2025-10-25",
            start: "2025-07-01",
            end: "2025-09-30",
          }),
        },
      },
    },
    cik: "789019",
    statementType: "cash_flow",
    period: "quarter",
  })

  assert.equal(summary.fiscalPeriod, "Q1")
  assert.equal(summary.reportedFacts.operatingCashFlow.value, 120)
  assert.equal(summary.computedValues.freeCashFlow, 100)
  assert.equal(summary.computedValues.freeCashFlowMargin, 0.25)
})

test("SEC company facts compact summary excludes raw fact payloads", () => {
  const summary = summarizeSecCompanyFacts({
    data: {
      entityName: "Microsoft Corp",
      facts: {
        dei: {},
        "us-gaap": {
          Revenues: fact(100),
          GrossProfit: fact(60),
          OperatingIncomeLoss: fact(30),
          NetIncomeLoss: fact(20),
        },
      },
    },
    cik: "789019",
  })

  assert.equal(summary.entityName, "Microsoft Corp")
  assert.equal(summary.usGaapConceptCount, 4)
  assert.equal(
    summary.latestAnnualIncomeStatement.computedValues.netMargin,
    0.2
  )
  assert.equal(JSON.stringify(summary).includes('"facts"'), false)
})
