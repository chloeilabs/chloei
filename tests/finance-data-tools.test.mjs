import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const financeToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-finance-data-tools.ts")
).href

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const {
  classifyFinanceDataRetry,
  createAiSdkFinanceDataEvidenceContext,
  getAiSdkFinanceDataToolCallMetadata,
  getAiSdkFinanceDataToolResultMetadata,
  runFinanceDataOperation,
} = await import(financeToolsUrl)

test("finance data retry classification marks transient failures", () => {
  assert.equal(classifyFinanceDataRetry({ status: 429 }), true)
  assert.equal(classifyFinanceDataRetry({ status: 503 }), true)
  assert.equal(classifyFinanceDataRetry({ status: 404 }), false)
  assert.equal(classifyFinanceDataRetry({ code: "ETIMEDOUT" }), true)
})

test("finance data operation returns sanitized provider sources", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "quote",
      provider: "fmp",
      symbol: "AAPL",
    },
    {
      fmpApiKey: "secret-key",
      fetchImpl: async (url) => {
        assert.match(String(url), /apikey=secret-key/)
        return new Response(JSON.stringify([{ symbol: "AAPL", price: 200 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "fmp")
  assert.equal(result.output?.requestUrl.includes("secret-key"), false)
  assert.equal(result.output?.sources[0]?.title, "Financial Modeling Prep")
})

test("finance evidence context prefetches quote and profile data", async () => {
  const result = await createAiSdkFinanceDataEvidenceContext({
    query: "What is Apple's current stock price and market cap? Cite sources.",
    fmpApiKey: "secret-key",
    fetchImpl: async (url) => {
      const requestUrl = String(url)
      if (requestUrl.includes("financialmodelingprep.com")) {
        assert.match(requestUrl, /apikey=secret-key/)
        return new Response(
          JSON.stringify([
            {
              symbol: "AAPL",
              price: 280.14,
              marketCap: 4200000000000,
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      }

      if (requestUrl.includes("company_tickers.json")) {
        return new Response(
          JSON.stringify({
            0: {
              cik_str: 320193,
              ticker: "AAPL",
              title: "Apple Inc.",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      }

      if (requestUrl.includes("CIK0000320193.json")) {
        return new Response(
          JSON.stringify({
            cik: "320193",
            name: "Apple Inc.",
            tickers: ["AAPL"],
            exchanges: ["Nasdaq"],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      }

      if (requestUrl.includes("companiesmarketcap.com/apple/marketcap")) {
        return new Response(
          '<meta name="description" content="As of May 2026 Apple has a market cap of $4.112 Trillion USD.">',
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }
        )
      }

      throw new Error(`Unexpected URL: ${requestUrl}`)
    },
  })

  assert.equal(result.errors.length, 0)
  assert.equal(result.outputs.length, 2)
  assert.equal(result.supplements.length, 1)
  assert.match(result.context, /Resolved symbol: AAPL/)
  assert.match(result.context, /"marketCap": 4200000000000/)
  assert.match(result.context, /\$4\.112 Trillion USD/)
  assert.equal(
    result.sources.some((source) => source.title === "Financial Modeling Prep"),
    true
  )
  assert.equal(
    result.sources.some((source) => source.title === "CompaniesMarketCap"),
    true
  )
  assert.equal(
    result.sources.some((source) => source.title === "SEC company submissions"),
    true
  )
  assert.equal(result.context.includes("secret-key"), false)
})

test("finance provider status validates configured provider availability", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "provider_status",
      provider: "auto",
    },
    {
      fmpApiKey: "bad-key",
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("quote-short/AAPL")) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
        }

        if (requestUrl.includes("stooq.com")) {
          return new Response(
            [
              "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
              "AAPL.US,2026-04-24,22:00:19,272.755,273.06,269.65,271.06,38157110,APPLE INC",
            ].join("\n"),
            {
              status: 200,
              headers: { "Content-Type": "text/csv" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(result.output?.data.fmp, {
    configured: true,
    available: false,
    operations: [
      "symbol_search",
      "quote",
      "company_profile",
      "historical_prices",
      "financial_statements",
    ],
    errorCode: "HTTP_401",
    message: "fmp returned HTTP 401.",
  })
  assert.equal(result.output?.data.sec.available, true)
  assert.deepEqual(result.output?.data.sec.operations, [
    "symbol_search",
    "company_profile",
    "financial_statements",
    "sec_company_facts",
  ])
  assert.equal(result.output?.data.fred.configured, false)
  assert.equal(result.output?.data.stooq.available, true)
  assert.deepEqual(result.output?.data.stooq.operations, ["quote"])
})

test("finance quote auto provider uses Stooq structured fallback", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "quote",
      provider: "auto",
      symbol: "AA PL",
    },
    {
      fetchImpl: async (url) => {
        assert.match(String(url), /stooq\.com/)
        return new Response(
          [
            "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
            "AAPL.US,2026-04-24,22:00:19,272.755,273.06,269.65,271.06,38157110,APPLE INC",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/csv" },
          }
        )
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "stooq")
  assert.equal(result.output?.data.close, 271.06)
  assert.equal(result.output?.sources[0]?.title, "Stooq")
})

test("finance sources use unique ids for repeated operations", async () => {
  const fetchImpl = async (url) => {
    const requestUrl = String(url)
    const symbol = requestUrl.includes("msft.us") ? "MSFT.US" : "AAPL.US"
    return new Response(
      [
        "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
        `${symbol},2026-04-24,22:00:19,100,101,99,100,1000,TEST`,
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }
    )
  }
  const first = await runFinanceDataOperation(
    { operation: "quote", provider: "auto", symbol: "AAPL" },
    { fetchImpl }
  )
  const second = await runFinanceDataOperation(
    { operation: "quote", provider: "auto", symbol: "MSFT" },
    { fetchImpl }
  )

  assert.notEqual(first.output?.sources[0]?.id, second.output?.sources[0]?.id)
})

test("finance historical prices auto provider uses Stooq structured fallback", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "historical_prices",
      provider: "auto",
      symbol: "AAPL",
      from: "2026-04-22",
      to: "2026-04-24",
      limit: 2,
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        assert.match(requestUrl, /stooq\.com/)
        assert.match(requestUrl, /d1=20260422/)
        assert.match(requestUrl, /d2=20260424/)
        return new Response(
          [
            "Date,Open,High,Low,Close,Volume",
            "2026-04-22,260,265,259,264,1000",
            "2026-04-23,264,270,263,268,1100",
            "2026-04-24,268,273,267,271,1200",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/csv" },
          }
        )
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "stooq")
  assert.equal(result.output?.data.rows.length, 2)
  assert.equal(result.output?.data.rows[1].close, 271)
  assert.equal(result.output?.data.truncated, true)
})

test("finance company_profile auto provider uses SEC submissions fallback", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "company_profile",
      provider: "auto",
      symbol: "AA PL",
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("company_tickers.json")) {
          return new Response(
            JSON.stringify({
              0: {
                cik_str: 320193,
                ticker: "AAPL",
                title: "Apple Inc.",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        if (requestUrl.includes("CIK0000320193.json")) {
          return new Response(
            JSON.stringify({
              cik: "320193",
              name: "Apple Inc.",
              tickers: ["AAPL"],
              exchanges: ["Nasdaq"],
              sic: "3571",
              sicDescription: "Electronic Computers",
              ownerOrg: "06 Technology",
              fiscalYearEnd: "0928",
              stateOfIncorporation: "CA",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "sec")
  assert.equal(result.output?.data.name, "Apple Inc.")
  assert.deepEqual(result.output?.data.exchanges, ["Nasdaq"])
  assert.equal(result.output?.sources[0]?.title, "SEC company submissions")
})

test("finance income statement auto provider uses SEC company facts fallback", async () => {
  const result = await runFinanceDataOperation(
    {
      operation: "financial_statements",
      provider: "auto",
      symbol: "MSFT",
      statementType: "income",
      period: "annual",
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("company_tickers.json")) {
          return new Response(
            JSON.stringify({
              0: {
                cik_str: 789019,
                ticker: "MSFT",
                title: "Microsoft Corp",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        if (requestUrl.includes("CIK0000789019.json")) {
          if (requestUrl.includes("submissions")) {
            return new Response(
              JSON.stringify({
                filings: {
                  recent: {
                    form: ["10-K"],
                    filingDate: ["2025-07-30"],
                    accessionNumber: ["0000950170-25-100235"],
                    primaryDocument: ["msft-20250630.htm"],
                  },
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          }

          const fact = (val) => ({
            units: {
              USD: [
                {
                  val,
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-07-30",
                  start: "2024-07-01",
                  end: "2025-06-30",
                },
              ],
            },
          })
          return new Response(
            JSON.stringify({
              facts: {
                "us-gaap": {
                  RevenueFromContractWithCustomerExcludingAssessedTax:
                    fact(100),
                  GrossProfit: fact(70),
                  OperatingIncomeLoss: fact(45),
                  NetIncomeLoss: fact(35),
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "sec")
  assert.equal(result.output?.sources[0]?.title, "SEC company facts")
  assert.equal(result.output?.data.reportedFacts.revenue.value, 100)
  assert.equal(result.output?.data.reportedFacts.grossProfit.value, 70)
  assert.equal(result.output?.data.computedValues.grossMargin, 0.7)
  assert.equal(result.output?.data.computedValues.operatingMargin, 0.45)
  assert.equal(result.output?.data.computedValues.netMargin, 0.35)
  assert.match(result.output?.data.filing.url, /msft-20250630\.htm/)
  assert.equal(result.output?.sources.length, 2)
})

test("finance income statement falls back from unavailable FMP to SEC facts", async () => {
  const requestedUrls = []
  const result = await runFinanceDataOperation(
    {
      operation: "financial_statements",
      provider: "fmp",
      symbol: "MSFT",
      statementType: "income",
      period: "annual",
    },
    {
      fmpApiKey: "bad-key",
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        requestedUrls.push(requestUrl)
        if (requestUrl.includes("income-statement/MSFT")) {
          return new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        }

        if (requestUrl.includes("company_tickers.json")) {
          return new Response(
            JSON.stringify({
              0: {
                cik_str: 789019,
                ticker: "MSFT",
                title: "Microsoft Corp",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        if (requestUrl.includes("CIK0000789019.json")) {
          if (requestUrl.includes("submissions")) {
            return new Response(
              JSON.stringify({
                filings: {
                  recent: {
                    form: ["10-K"],
                    filingDate: ["2025-07-30"],
                    accessionNumber: ["0000950170-25-100235"],
                    primaryDocument: ["msft-20250630.htm"],
                  },
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          }

          const fact = (val) => ({
            units: {
              USD: [
                {
                  val,
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-07-30",
                  start: "2024-07-01",
                  end: "2025-06-30",
                },
              ],
            },
          })
          return new Response(
            JSON.stringify({
              facts: {
                "us-gaap": {
                  Revenues: fact(100),
                  GrossProfit: fact(60),
                  OperatingIncomeLoss: fact(30),
                  NetIncomeLoss: fact(20),
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "sec")
  assert.equal(result.output?.data.computedValues.grossMargin, 0.6)
  assert.match(result.output?.data.filing.url, /msft-20250630\.htm/)
  assert.equal(
    requestedUrls.some((url) => url.includes("income-statement/MSFT")),
    true
  )
})

test("finance balance sheet auto provider uses SEC company facts fallback", async () => {
  const fact = (val) => ({
    units: {
      USD: [
        {
          val,
          fy: 2026,
          fp: "FY",
          form: "10-K",
          filed: "2026-02-25",
          end: "2026-01-25",
        },
      ],
    },
  })
  const result = await runFinanceDataOperation(
    {
      operation: "financial_statements",
      provider: "auto",
      symbol: "NVDA",
      statementType: "balance_sheet",
      period: "annual",
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("company_tickers.json")) {
          return new Response(
            JSON.stringify({
              0: {
                cik_str: 1045810,
                ticker: "NVDA",
                title: "NVIDIA CORP",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        if (requestUrl.includes("CIK0001045810.json")) {
          if (requestUrl.includes("submissions")) {
            return new Response(
              JSON.stringify({
                filings: {
                  recent: {
                    form: ["10-K"],
                    filingDate: ["2026-02-25"],
                    accessionNumber: ["0001045810-26-000021"],
                    primaryDocument: ["nvda-20260125.htm"],
                  },
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          }

          return new Response(
            JSON.stringify({
              facts: {
                "us-gaap": {
                  Assets: fact(1000),
                  Liabilities: fact(400),
                  StockholdersEquity: fact(600),
                  LongTermDebtNoncurrent: fact(80),
                  CashAndCashEquivalentsAtCarryingValue: fact(200),
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "sec")
  assert.equal(result.output?.data.statementType, "balance_sheet")
  assert.equal(result.output?.data.reportedFacts.totalLiabilities.value, 400)
  assert.equal(result.output?.data.reportedFacts.longTermDebt.value, 80)
  assert.equal(result.output?.data.computedValues.netDebt, -120)
  assert.equal(result.output?.data.computedValues.liabilitiesToAssets, 0.4)
  assert.match(result.output?.data.filing.url, /nvda-20260125\.htm/)
})

test("finance cash flow auto provider uses SEC company facts fallback", async () => {
  const fact = (val) => ({
    units: {
      USD: [
        {
          val,
          fy: 2026,
          fp: "FY",
          form: "10-K",
          filed: "2026-02-25",
          start: "2025-01-27",
          end: "2026-01-25",
        },
      ],
    },
  })
  const result = await runFinanceDataOperation(
    {
      operation: "financial_statements",
      provider: "auto",
      symbol: "NVDA",
      statementType: "cash_flow",
      period: "annual",
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("company_tickers.json")) {
          return new Response(
            JSON.stringify({
              0: {
                cik_str: 1045810,
                ticker: "NVDA",
                title: "NVIDIA CORP",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        if (requestUrl.includes("CIK0001045810.json")) {
          if (requestUrl.includes("submissions")) {
            return new Response(
              JSON.stringify({
                filings: {
                  recent: {
                    form: ["10-K"],
                    filingDate: ["2026-02-25"],
                    accessionNumber: ["0001045810-26-000021"],
                    primaryDocument: ["nvda-20260125.htm"],
                  },
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          }

          return new Response(
            JSON.stringify({
              facts: {
                "us-gaap": {
                  NetCashProvidedByUsedInOperatingActivities: fact(640),
                  PaymentsToAcquirePropertyPlantAndEquipment: fact(120),
                  Revenues: fact(1300),
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.provider, "sec")
  assert.equal(result.output?.data.statementType, "cash_flow")
  assert.equal(result.output?.data.reportedFacts.operatingCashFlow.value, 640)
  assert.equal(result.output?.data.reportedFacts.capitalExpenditures.value, 120)
  assert.equal(result.output?.data.computedValues.freeCashFlow, 520)
  assert.equal(result.output?.data.computedValues.freeCashFlowMargin, 0.4)
  assert.match(result.output?.data.filing.url, /nvda-20260125\.htm/)
})

test("sec company facts returns compact summarized data", async () => {
  const fact = (val) => ({
    units: {
      USD: [
        {
          val,
          fy: 2025,
          fp: "FY",
          form: "10-K",
          filed: "2025-07-30",
          start: "2024-07-01",
          end: "2025-06-30",
        },
      ],
    },
  })
  const result = await runFinanceDataOperation(
    {
      operation: "sec_company_facts",
      provider: "sec",
      cik: "789019",
    },
    {
      fetchImpl: async (url) => {
        assert.match(String(url), /CIK0000789019\.json/)
        return new Response(
          JSON.stringify({
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
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      },
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.output?.data.entityName, "Microsoft Corp")
  assert.equal(result.output?.data.usGaapConceptCount, 4)
  assert.equal(
    result.output?.data.latestAnnualIncomeStatement.computedValues.netMargin,
    0.2
  )
  assert.equal(JSON.stringify(result.output?.data).includes('"facts"'), false)
})

test("finance data operation returns structured provider-unavailable errors", async () => {
  const result = await runFinanceDataOperation({
    operation: "fred_series",
    provider: "fred",
    seriesId: "CPIAUCSL",
  })

  assert.equal(result.output, undefined)
  assert.equal(result.error?.code, "PROVIDER_UNAVAILABLE")
  assert.equal(result.error?.retryable, false)
})

test("finance data metadata includes operation and provider", () => {
  assert.deepEqual(
    getAiSdkFinanceDataToolCallMetadata({
      toolCallId: "call-1",
      toolName: "finance_data",
      input: {
        operation: "financial_statements",
        provider: "fmp",
      },
    }),
    {
      callId: "call-1",
      toolName: "finance_data",
      label: "Finance: Financial Statements",
      operation: "financial_statements",
      provider: "fmp",
      attempt: 1,
    }
  )

  assert.deepEqual(
    getAiSdkFinanceDataToolResultMetadata({
      toolCallId: "call-1",
      toolName: "finance_data",
      output: {
        error: {
          operation: "quote",
          provider: "fmp",
          code: "HTTP_429",
          message: "Rate limited.",
          attempts: 2,
          durationMs: 25,
          retryable: true,
        },
      },
    }),
    {
      callId: "call-1",
      toolName: "finance_data",
      status: "error",
      sources: [],
      operation: "quote",
      provider: "fmp",
      attempt: 2,
      durationMs: 25,
      errorCode: "HTTP_429",
      retryable: true,
    }
  )
})
