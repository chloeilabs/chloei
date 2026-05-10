import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const secFilingsToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-sec-filings-tools.ts")
).href

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const {
  __secFilingsTestInternals,
  getAiSdkSecFilingsToolCallMetadata,
  getAiSdkSecFilingsToolResultMetadata,
  runSecFilingsOperation,
} = await import(secFilingsToolsUrl)

const companyTickers = {
  0: {
    cik_str: 1065280,
    ticker: "NFLX",
    title: "NETFLIX INC",
  },
}

const submissions = {
  filings: {
    recent: {
      form: ["8-K", "10-K", "10-K"],
      filingDate: ["2025-02-01", "2025-01-27", "2024-01-26"],
      reportDate: ["2025-02-01", "2024-12-31", "2023-12-31"],
      accessionNumber: [
        "0001065280-25-000021",
        "0001065280-25-000044",
        "0001065280-24-000030",
      ],
      primaryDocument: [
        "nflx-20250201.htm",
        "nflx-20241231.htm",
        "nflx-20231231.htm",
      ],
      primaryDocDescription: [
        "Current report",
        "10-K annual report",
        "10-K annual report",
      ],
    },
  },
}

const filingHtml = `
<html>
  <body>
    <h1>Item 2. Properties</h1>
    <p>Netflix leases corporate offices and production facilities.</p>
    <h1>Item 7. Management's Discussion and Analysis</h1>
    <p>Total revenue increased 15% year over year.</p>
    <h2>Earnings per Share</h2>
    <table>
      <tr><th>Year Ended December 31</th></tr>
      <tr><td>Shares used in computation</td><td>4,249,512</td></tr>
      <tr><td>Basic earnings per share</td><td>$2.58</td></tr>
    </table>
    <h2>Issuer Purchases of Equity Securities</h2>
    <table>
      <tr><th>Period</th><th>Total Number of Shares Purchased</th><th>Average Price Paid per Share</th></tr>
      <tr><td>October 2024</td><td>519,883</td><td>$724.15</td></tr>
      <tr><td>November 2024</td><td>457,732</td><td>$792.49</td></tr>
      <tr><td>December 2024</td><td>188,212</td><td>$913.13</td></tr>
    </table>
    <h1>Item 7A. Quantitative and Qualitative Disclosures</h1>
    <p>Market risk disclosure.</p>
  </body>
</html>
`

function createSecFetch() {
  const calls = []
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url)
    calls.push({ url: requestUrl, headers: init?.headers })

    if (requestUrl.includes("company_tickers.json")) {
      return new Response(JSON.stringify(companyTickers), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (requestUrl.includes("submissions/CIK0001065280.json")) {
      return new Response(JSON.stringify(submissions), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (requestUrl.includes("nflx-20241231.htm")) {
      return new Response(filingHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    return new Response("not found", { status: 404 })
  }

  return { calls, fetchImpl }
}

test("sec filings searches companies and filings with SEC sources", async () => {
  const { calls, fetchImpl } = createSecFetch()
  const companySearch = await runSecFilingsOperation(
    {
      operation: "company_search",
      query: "Netflix",
    },
    { fetchImpl, secUserAgent: "Chloei tests contact@example.com" }
  )

  assert.equal(companySearch.error, undefined)
  assert.equal(companySearch.output?.provider, "sec")
  assert.equal(companySearch.output?.data[0]?.ticker, "NFLX")
  assert.equal(companySearch.output?.sources[0]?.title, "SEC company tickers")

  const symbolCompanySearch = await runSecFilingsOperation(
    {
      operation: "company_search",
      symbol: "NFLX",
    },
    { fetchImpl, secUserAgent: "Chloei tests contact@example.com" }
  )

  assert.equal(symbolCompanySearch.error, undefined)
  assert.equal(symbolCompanySearch.output?.data[0]?.cik, "0001065280")

  const filingSearch = await runSecFilingsOperation(
    {
      operation: "filing_search",
      symbol: "NFLX",
      forms: ["10-K"],
      limit: 2,
    },
    { fetchImpl, secUserAgent: "Chloei tests contact@example.com" }
  )

  assert.equal(filingSearch.error, undefined)
  assert.equal(filingSearch.output?.data.filings.length, 2)
  assert.match(
    filingSearch.output?.data.filings[0]?.url,
    /Archives\/edgar\/data\/1065280\/000106528025000044\/nflx-20241231\.htm/
  )
  assert.equal(
    calls.some((call) =>
      String(call.headers?.["User-Agent"] ?? "").includes("contact@example.com")
    ),
    true
  )
  assert.equal(
    filingSearch.output?.sources.some((source) =>
      source.url.includes("contact@example.com")
    ),
    false
  )
})

test("sec filings extracts sections, tables, and retrieval snippets", async () => {
  const { fetchImpl } = createSecFetch()
  const section = await runSecFilingsOperation(
    {
      operation: "section_extract",
      symbol: "NFLX",
      forms: ["10-K"],
      item: "Item 7",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(section.error, undefined)
  assert.match(section.output?.data.text, /Total revenue increased 15%/)
  assert.doesNotMatch(section.output?.data.text, /Market risk disclosure/)

  const namedSection = await runSecFilingsOperation(
    {
      operation: "section_extract",
      symbol: "NFLX",
      forms: ["10-K"],
      item: "Issuer Purchases of Equity Securities",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(namedSection.error, undefined)
  assert.match(
    namedSection.output?.data.text,
    /Total Number of Shares Purchased/
  )

  const fallbackSection = await runSecFilingsOperation(
    {
      operation: "section_extract",
      symbol: "NFLX",
      forms: ["10-K"],
      item: "Item 2",
      query: "Issuer Purchases Total Number of Shares Purchased",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(fallbackSection.error, undefined)
  assert.equal(fallbackSection.output?.data.fallback, "document_snippets")
  assert.match(
    fallbackSection.output?.data.text,
    /Total Number of Shares Purchased/
  )

  const tables = await runSecFilingsOperation(
    {
      operation: "table_extract",
      symbol: "NFLX",
      forms: ["10-K"],
      query: "Issuer Purchases Total Number of Shares Purchased",
    },
    { fetchImpl }
  )

  assert.equal(tables.error, undefined)
  assert.deepEqual(tables.output?.data.tables[0]?.rows[1], [
    "October 2024",
    "519,883",
    "$724.15",
  ])

  const retrieval = await runSecFilingsOperation(
    {
      operation: "retrieve_information",
      symbol: "NFLX",
      forms: ["10-K"],
      query: "revenue increased",
    },
    { fetchImpl }
  )

  assert.equal(retrieval.error, undefined)
  assert.match(retrieval.output?.data.snippets[0]?.text, /revenue increased/i)
})

test("sec filings targets accession numbers without drifting to newer filings", async () => {
  const { calls, fetchImpl } = createSecFetch()
  const tables = await runSecFilingsOperation(
    {
      operation: "table_extract",
      accessionNumber: "0001065280-25-000044",
      query: "Issuer Purchases Total Number of Shares Purchased",
    },
    { fetchImpl }
  )

  assert.equal(tables.error, undefined)
  assert.equal(tables.output?.data.url.includes("nflx-20241231.htm"), true)
  assert.equal(tables.output?.data.url.includes("nflx-20250201.htm"), false)
  assert.deepEqual(tables.output?.data.tables[0]?.rows[2], [
    "November 2024",
    "457,732",
    "$792.49",
  ])
  assert.equal(
    calls.some((call) => call.url.includes("company_tickers.json")),
    false
  )
})

test("sec filings recovers bad SEC archive urls through accession lookup", async () => {
  const { fetchImpl } = createSecFetch()
  const document = await runSecFilingsOperation(
    {
      operation: "document_fetch",
      url: "https://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/wrong-primary-document.htm",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(document.error, undefined)
  assert.equal(document.output?.data.url.includes("nflx-20241231.htm"), true)
  assert.match(document.output?.data.text, /Total revenue increased 15%/)
})

test("sec filings rejects non-SEC archive urls before fetching", async () => {
  const { calls, fetchImpl } = createSecFetch()
  const document = await runSecFilingsOperation(
    {
      operation: "document_fetch",
      url: "http://169.254.169.254/Archives/edgar/data/1065280/000106528025000044/nflx-20241231.htm",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(document.output, undefined)
  assert.equal(document.error?.code, "INVALID_INPUT")
  assert.equal(document.error?.retryable, false)
  assert.equal(calls.length, 0)
})

test("sec filings recovers bad primary documents through accession lookup", async () => {
  const { fetchImpl } = createSecFetch()
  const document = await runSecFilingsOperation(
    {
      operation: "document_fetch",
      accessionNumber: "0001065280-25-000044",
      primaryDocument: "wrong-primary-document.htm",
      maxChars: 2_000,
    },
    { fetchImpl }
  )

  assert.equal(document.error, undefined)
  assert.equal(document.output?.data.url.includes("nflx-20241231.htm"), true)
  assert.match(document.output?.data.text, /Total revenue increased 15%/)
})

test("sec filings metadata maps tool call and result events", () => {
  const callMetadata = getAiSdkSecFilingsToolCallMetadata({
    toolCallId: "call-1",
    toolName: "sec_filings",
    input: {
      operation: "table_extract",
      symbol: "NFLX",
      query: "repurchases",
    },
  })

  assert.deepEqual(callMetadata, {
    callId: "call-1",
    toolName: "sec_filings",
    label: "Extracting SEC filing tables",
    query: "repurchases | NFLX",
    operation: "table_extract",
    provider: "sec",
  })

  const resultMetadata = getAiSdkSecFilingsToolResultMetadata({
    toolCallId: "call-1",
    toolName: "sec_filings",
    output: {
      output: {
        operation: "table_extract",
        provider: "sec",
        data: {},
        sources: [{ id: "sec-1", url: "https://www.sec.gov", title: "SEC" }],
        durationMs: 12,
        attempts: 2,
      },
    },
  })

  assert.equal(resultMetadata?.status, "success")
  assert.equal(resultMetadata?.operation, "table_extract")
  assert.equal(resultMetadata?.provider, "sec")
  assert.equal(resultMetadata?.attempt, 2)
  assert.deepEqual(resultMetadata?.sources, [
    { id: "sec-1", url: "https://www.sec.gov", title: "SEC" },
  ])
})

test("sec filings internals build EDGAR URLs and parse simple tables", () => {
  assert.equal(
    __secFilingsTestInternals.buildSecFilingUrl({
      cik: "1065280",
      accessionNumber: "0001065280-25-000044",
      primaryDocument: "nflx-20241231.htm",
    }),
    "https://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/nflx-20241231.htm"
  )
  assert.equal(
    __secFilingsTestInternals.deriveCikFromAccession("0001065280-25-000044"),
    "0001065280"
  )
  assert.deepEqual(
    __secFilingsTestInternals.parseSecArchiveUrl(
      "https://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/wrong.htm"
    ),
    {
      cik: "0001065280",
      accessionNumber: "0001065280-25-000044",
    }
  )
  assert.equal(
    __secFilingsTestInternals.parseSecArchiveUrl(
      "https://example.com/Archives/edgar/data/1065280/000106528025000044/wrong.htm"
    ),
    null
  )
  assert.equal(
    __secFilingsTestInternals.parseSecArchiveUrl(
      "http://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/wrong.htm"
    ),
    null
  )
  assert.equal(
    __secFilingsTestInternals.parseSecArchiveUrl(
      "https://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/nested/wrong.htm"
    ),
    null
  )

  assert.deepEqual(
    __secFilingsTestInternals.parseHtmlTables(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
    )[0]?.rows,
    [
      ["A", "B"],
      ["1", "2"],
    ]
  )
})
