import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const yahooUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/finance-data/yahoo-provider.ts")
).href
const sourcesUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/finance-data/sources.ts")
).href

const {
  normalizeYahooQuote,
  normalizeYahooHistorical,
  normalizeYahooProfile,
  normalizeYahooFinancials,
  normalizeYahooSearch,
  normalizeYahooRecommendations,
  normalizeYahooOptions,
  buildYahooSourceUrl,
} = await import(yahooUrl)
const { createFinanceDataProviderSource } = await import(sourcesUrl)

test("normalizeYahooQuote surfaces rich fields any-symbol Stooq cannot", () => {
  const quote = normalizeYahooQuote(
    {
      symbol: "AAPL",
      shortName: "Apple Inc.",
      longName: "Apple Inc.",
      regularMarketPrice: 195.1,
      regularMarketChange: 1.2,
      regularMarketChangePercent: 0.6,
      regularMarketVolume: 50_000_000,
      marketCap: 3_000_000_000_000,
      trailingPE: 32.5,
      fiftyTwoWeekHigh: 199,
      fiftyTwoWeekLow: 164,
      currency: "USD",
      fullExchangeName: "NasdaqGS",
      regularMarketTime: 1_717_000_000,
    },
    "aapl"
  )
  assert.equal(quote.symbol, "AAPL")
  assert.equal(quote.name, "Apple Inc.")
  assert.equal(quote.price, 195.1)
  assert.equal(quote.marketCap, 3_000_000_000_000)
  assert.equal(quote.trailingPE, 32.5)
  assert.equal(quote.exchange, "NasdaqGS")
  assert.match(quote.asOf, /^\d{4}-\d{2}-\d{2}T/)
})

test("normalizeYahooQuote throws a retryable error when price is missing", () => {
  assert.throws(
    () => normalizeYahooQuote({ symbol: "AAPL" }, "AAPL"),
    (error) => error.code === "QUOTE_UNAVAILABLE" && error.retryable === true
  )
})

test("normalizeYahooHistorical maps chart quotes and honors the limit", () => {
  const result = normalizeYahooHistorical(
    {
      quotes: [
        {
          date: new Date("2024-05-01"),
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 100,
          adjclose: 1.4,
        },
        {
          date: new Date("2024-05-02"),
          open: 1.5,
          high: 2.5,
          low: 1,
          close: 2,
          volume: 110,
          adjclose: 1.9,
        },
        {
          date: new Date("2024-05-03"),
          open: 2,
          high: 3,
          low: 1.5,
          close: 2.5,
          volume: 120,
          adjclose: 2.4,
        },
      ],
    },
    "MSFT",
    { operation: "historical_prices", limit: 2 }
  )
  assert.equal(result.symbol, "MSFT")
  assert.equal(result.rowCount, 2)
  assert.equal(result.totalRowsAvailable, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].date, "2024-05-02")
  assert.equal(result.rows[1].close, 2.5)
})

test("normalizeYahooProfile covers non-US fundamentals fields", () => {
  const profile = normalizeYahooProfile(
    {
      assetProfile: {
        sector: "Consumer Cyclical",
        industry: "Auto Manufacturers",
        country: "Japan",
        website: "https://toyota.example",
        longBusinessSummary: "Toyota makes cars.",
        fullTimeEmployees: 375_000,
      },
      price: {
        longName: "Toyota Motor Corp",
        marketCap: { raw: 250_000_000_000 },
        currency: "JPY",
        exchangeName: "Tokyo",
      },
    },
    "7203.T"
  )
  assert.equal(profile.symbol, "7203.T")
  assert.equal(profile.name, "Toyota Motor Corp")
  assert.equal(profile.sector, "Consumer Cyclical")
  assert.equal(profile.country, "Japan")
  assert.equal(profile.marketCap, 250_000_000_000)
  assert.equal(profile.currency, "JPY")
})

test("normalizeYahooFinancials extracts statements with the {raw} value shape", () => {
  const financials = normalizeYahooFinancials(
    {
      incomeStatementHistory: {
        incomeStatementHistory: [
          {
            endDate: { raw: 1_696_032_000, fmt: "2023-09-30" },
            totalRevenue: { raw: 383_285_000_000 },
            grossProfit: { raw: 169_148_000_000 },
            netIncome: { raw: 96_995_000_000 },
          },
        ],
      },
    },
    "AAPL",
    {
      operation: "financial_statements",
      statementType: "income",
      period: "annual",
    }
  )
  assert.equal(financials.statementType, "income")
  assert.equal(financials.periods.length, 1)
  assert.equal(financials.periods[0].endDate, "2023-09-30")
  assert.equal(financials.periods[0].totalRevenue, 383_285_000_000)
  assert.equal(financials.periods[0].netIncome, 96_995_000_000)
})

test("normalizeYahooSearch maps quote rows", () => {
  const result = normalizeYahooSearch(
    {
      quotes: [
        {
          symbol: "AAPL",
          shortname: "Apple Inc.",
          exchDisp: "NASDAQ",
          quoteType: "EQUITY",
        },
        { symbol: "APLE", longname: "Apple Hospitality REIT" },
        { /* no symbol */ shortname: "ignored" },
      ],
    },
    "apple",
    10
  )
  assert.equal(result.rowCount, 2)
  assert.equal(result.rows[0].symbol, "AAPL")
  assert.equal(result.rows[0].exchange, "NASDAQ")
  assert.equal(result.rows[1].name, "Apple Hospitality REIT")
})

test("normalizeYahooRecommendations exposes targets + trend (no current source today)", () => {
  const rec = normalizeYahooRecommendations(
    {
      financialData: {
        recommendationKey: "buy",
        numberOfAnalystOpinions: { raw: 40 },
        targetMeanPrice: { raw: 210 },
        targetHighPrice: { raw: 260 },
        targetLowPrice: { raw: 160 },
        currentPrice: { raw: 195 },
        financialCurrency: "USD",
      },
      recommendationTrend: {
        trend: [
          {
            period: "0m",
            strongBuy: 12,
            buy: 20,
            hold: 8,
            sell: 1,
            strongSell: 0,
          },
        ],
      },
    },
    "AAPL"
  )
  assert.equal(rec.recommendationKey, "buy")
  assert.equal(rec.targetMeanPrice, 210)
  assert.equal(rec.numberOfAnalystOpinions, 40)
  assert.equal(rec.trend.length, 1)
  assert.equal(rec.trend[0].strongBuy, 12)
})

test("normalizeYahooOptions returns nearest expiration and caps contracts", () => {
  const calls = Array.from({ length: 30 }, (_, index) => ({
    contractSymbol: `AAPL240621C${index}`,
    strike: 150 + index,
    lastPrice: 1,
    bid: 0.9,
    ask: 1.1,
    volume: 10,
    openInterest: 100,
    impliedVolatility: 0.3,
    inTheMoney: false,
  }))
  const options = normalizeYahooOptions(
    {
      expirationDates: [new Date("2024-06-21"), new Date("2024-06-28")],
      strikes: [150, 160, 170],
      quote: { regularMarketPrice: 195, currency: "USD" },
      options: [{ expirationDate: new Date("2024-06-21"), calls, puts: [] }],
    },
    "AAPL"
  )
  assert.equal(options.symbol, "AAPL")
  assert.equal(options.underlyingPrice, 195)
  assert.equal(options.expiration, "2024-06-21")
  assert.deepEqual(options.expirationDates, ["2024-06-21", "2024-06-28"])
  assert.equal(options.calls.totalAvailable, 30)
  assert.equal(options.calls.truncated, true)
  assert.equal(options.calls.contracts.length, 24)
})

test("yahoo source URLs and provider title are stable", () => {
  assert.equal(
    buildYahooSourceUrl("quote", "aapl").toString(),
    "https://finance.yahoo.com/quote/AAPL"
  )
  assert.equal(
    buildYahooSourceUrl("history", "msft").toString(),
    "https://finance.yahoo.com/quote/MSFT/history"
  )
  assert.equal(
    buildYahooSourceUrl("options", "tsla").toString(),
    "https://finance.yahoo.com/quote/TSLA/options"
  )
  assert.equal(
    createFinanceDataProviderSource(
      "yahoo",
      "analyst_recommendations",
      buildYahooSourceUrl("analysis", "AAPL")
    ).title,
    "Yahoo Finance"
  )
})
