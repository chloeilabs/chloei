import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/finance-data/sources.ts")
).href

const { createFinanceDataProviderSource, createFinanceDataSourceId } =
  await import(moduleUrl)

test("finance data provider sources sanitize API keys and preserve stable ids", () => {
  const first = createFinanceDataProviderSource(
    "fmp",
    "quote",
    new URL("https://example.com/quote?symbol=AAPL&apikey=secret")
  )
  const second = createFinanceDataProviderSource(
    "fmp",
    "quote",
    new URL("https://example.com/quote?symbol=AAPL&apikey=another-secret")
  )

  assert.equal(first.title, "Financial Modeling Prep")
  assert.equal(first.url, "https://example.com/quote?symbol=AAPL")
  assert.equal(second.url, "https://example.com/quote?symbol=AAPL")
  assert.equal(first.id, second.id)
})

test("finance data provider sources label SEC facts and submissions distinctly", () => {
  assert.equal(
    createFinanceDataProviderSource(
      "sec",
      "financial_statements",
      new URL("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json")
    ).title,
    "SEC company facts"
  )
  assert.equal(
    createFinanceDataProviderSource(
      "sec",
      "company_profile",
      new URL("https://data.sec.gov/submissions/CIK0000320193.json")
    ).title,
    "SEC company submissions"
  )
})

test("finance data source ids can be shared by non-provider source entries", () => {
  const sourceUrl =
    "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"

  assert.match(
    createFinanceDataSourceId(["sec", "filing"], sourceUrl),
    /^finance_data-sec-filing-[a-z0-9]+$/
  )
})
