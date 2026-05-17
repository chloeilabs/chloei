import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-generative-ui-tools.ts")
).href

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const { runStockCardTool, runWeatherCardTool } = await import(moduleUrl)

test("weather card tool normalizes Open-Meteo geocoding and forecast data", async () => {
  const output = await runWeatherCardTool(
    {
      location: "Chicago",
      unit: "fahrenheit",
    },
    {
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("geocoding-api.open-meteo.com")) {
          return Response.json({
            results: [
              {
                name: "Chicago",
                admin1: "Illinois",
                country: "United States",
                latitude: 41.85,
                longitude: -87.65,
              },
            ],
          })
        }

        if (requestUrl.includes("api.open-meteo.com")) {
          return Response.json({
            current: {
              time: "2026-05-16T10:00",
              temperature_2m: 72,
              apparent_temperature: 73,
              relative_humidity_2m: 45,
              weather_code: 0,
              wind_speed_10m: 8,
              wind_direction_10m: 270,
            },
            daily: {
              time: ["2026-05-16", "2026-05-17"],
              weather_code: [0, 61],
              temperature_2m_max: [76, 70],
              temperature_2m_min: [61, 58],
              precipitation_probability_max: [10, 40],
            },
          })
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(output.provider, "open-meteo")
  assert.equal(output.resolvedLocation, "Chicago, Illinois, United States")
  assert.equal(output.temperature, 72)
  assert.equal(output.condition, "Clear")
  assert.equal(output.forecast.length, 2)
  assert.match(output.sourceUrl ?? "", /temperature_unit=fahrenheit/)
})

test("stock card tool falls back from FMP to Stooq without leaking the API key", async () => {
  const output = await runStockCardTool(
    {
      symbol: "AAPL",
      range: "5d",
    },
    {
      fmpApiKey: "secret-key",
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("financialmodelingprep.com")) {
          assert.match(requestUrl, /apikey=secret-key/)
          return new Response("provider unavailable", { status: 500 })
        }

        if (requestUrl.includes("stooq.com/q/l/")) {
          return new Response(
            [
              "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
              "AAPL.US,2026-05-15,22:00:00,210,216,209,215,123456,Apple Inc.",
            ].join("\n")
          )
        }

        if (requestUrl.includes("stooq.com/q/d/l/")) {
          return new Response(
            [
              "Date,Open,High,Low,Close,Volume",
              "2026-05-12,200,205,199,204,1000",
              "2026-05-13,204,208,203,207,1100",
              "2026-05-14,207,212,206,211,1200",
              "2026-05-15,210,216,209,215,123456",
            ].join("\n")
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(output.provider, "stooq")
  assert.equal(output.symbol, "AAPL.US")
  assert.equal(output.price, 215)
  assert.equal(output.history.length, 4)
  assert.equal(output.sourceUrl?.includes("secret-key"), false)
})

test("stock card tool labels finance_data internal FMP fallback as Stooq", async () => {
  const output = await runStockCardTool(
    {
      symbol: "MSFT",
      range: "5d",
    },
    {
      fmpApiKey: "secret-key",
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.includes("financialmodelingprep.com")) {
          return new Response("forbidden", { status: 403 })
        }

        if (requestUrl.includes("stooq.com/q/l/")) {
          return new Response(
            [
              "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
              "MSFT.US,2026-05-15,22:00:00,500,510,498,508,98765,Microsoft Corp.",
            ].join("\n")
          )
        }

        if (requestUrl.includes("stooq.com/q/d/l/")) {
          return new Response(
            [
              "Date,Open,High,Low,Close,Volume",
              "2026-05-14,498,505,496,501,9000",
              "2026-05-15,500,510,498,508,98765",
            ].join("\n")
          )
        }

        throw new Error(`Unexpected URL: ${requestUrl}`)
      },
    }
  )

  assert.equal(output.provider, "stooq")
  assert.equal(output.symbol, "MSFT.US")
  assert.equal(output.sourceUrl?.includes("stooq.com"), true)
  assert.equal(output.sourceUrl?.includes("secret-key"), false)
})
