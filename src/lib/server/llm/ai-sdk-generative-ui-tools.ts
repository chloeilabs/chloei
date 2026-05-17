import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import type {
  GenerativeUiMessagePart,
  GenerativeUiToolName,
  MessageSource,
  StockCardOutput,
  StockPricePoint,
  StockRange,
  StockToolInput,
  ToolName,
  WeatherCardOutput,
  WeatherForecastDay,
  WeatherToolInput,
  WeatherUnit,
} from "@/lib/shared"

import { runFinanceDataOperation } from "./ai-sdk-finance-data-tools"

const DISPLAY_WEATHER_TOOL_NAME = "display_weather" as const
const DISPLAY_STOCK_TOOL_NAME = "display_stock" as const
const OPEN_METEO_GEOCODING_URL =
  "https://geocoding-api.open-meteo.com/v1/search"
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

interface GenerativeUiToolConfig {
  fmpApiKey?: string
  fetchImpl?: typeof fetch
}

interface AiSdkGenerativeUiToolCallMetadata {
  callId: string
  toolName: Extract<ToolName, GenerativeUiToolName>
  label: string
  query?: string
  operation?: string
  provider?: string
}

interface AiSdkGenerativeUiToolResultMetadata {
  callId: string
  toolName: Extract<ToolName, GenerativeUiToolName>
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
}

const weatherInputSchema = z.object({
  location: z.string().trim().min(1).max(500),
  unit: z.enum(["fahrenheit", "celsius"]).default("fahrenheit").optional(),
})

const stockInputSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
  range: z.enum(["5d", "1m", "6m", "1y"]).default("1m").optional(),
})

type DisplayWeatherInput = z.infer<typeof weatherInputSchema>
type DisplayStockInput = z.infer<typeof stockInputSchema>

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function toNullableNumber(value: unknown): number | null {
  return toFiniteNumber(value)
}

function normalizeWeatherUnit(value: unknown): WeatherUnit {
  return value === "celsius" ? "celsius" : "fahrenheit"
}

function normalizeStockRange(value: unknown): StockRange {
  return value === "5d" || value === "6m" || value === "1y" ? value : "1m"
}

function normalizeWeatherInput(input: unknown): WeatherToolInput | null {
  const record = asRecord(input)
  const location = toOptionalString(record?.location)
  if (!location) {
    return null
  }

  return {
    location,
    unit: normalizeWeatherUnit(record?.unit),
  }
}

function normalizeStockInput(input: unknown): StockToolInput | null {
  const record = asRecord(input)
  const symbol = toOptionalString(record?.symbol)?.toUpperCase()
  if (!symbol) {
    return null
  }

  return {
    symbol,
    range: normalizeStockRange(record?.range),
  }
}

function hashSourceId(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash.toString(36)
}

function createSource(params: {
  prefix: string
  title: string
  url: string
}): MessageSource {
  return {
    id: `${params.prefix}-${hashSourceId(params.url)}`,
    title: params.title,
    url: params.url,
  }
}

async function fetchJson(params: {
  fetchImpl: typeof fetch
  url: URL
}): Promise<unknown> {
  const response = await params.fetchImpl(params.url, {
    headers: {
      Accept: "application/json",
    },
  })
  if (!response.ok) {
    throw new Error(`Provider returned HTTP ${String(response.status)}.`)
  }

  return response.json() as Promise<unknown>
}

function weatherCodeToCondition(code: number | null): string {
  if (code === 0) return "Clear"
  if (code === 1 || code === 2) return "Partly cloudy"
  if (code === 3) return "Overcast"
  if (code === 45 || code === 48) return "Fog"
  if (code !== null && code >= 51 && code <= 57) return "Drizzle"
  if (code !== null && code >= 61 && code <= 67) return "Rain"
  if (code !== null && code >= 71 && code <= 77) return "Snow"
  if (code !== null && code >= 80 && code <= 82) return "Rain showers"
  if (code !== null && code >= 85 && code <= 86) return "Snow showers"
  if (code !== null && code >= 95 && code <= 99) return "Thunderstorm"
  return "Unavailable"
}

function getResolvedLocation(result: Record<string, unknown>): string {
  const parts = [
    toOptionalString(result.name),
    toOptionalString(result.admin1),
    toOptionalString(result.country),
  ]

  return parts.filter(Boolean).join(", ")
}

function buildForecastUrl(params: {
  latitude: number
  longitude: number
  unit: WeatherUnit
}): URL {
  const url = new URL(OPEN_METEO_FORECAST_URL)
  url.searchParams.set("latitude", String(params.latitude))
  url.searchParams.set("longitude", String(params.longitude))
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(",")
  )
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
    ].join(",")
  )
  url.searchParams.set("timezone", "auto")
  url.searchParams.set("forecast_days", "5")
  url.searchParams.set("temperature_unit", params.unit)
  url.searchParams.set(
    "wind_speed_unit",
    params.unit === "fahrenheit" ? "mph" : "kmh"
  )
  return url
}

function normalizeWeatherForecast(data: unknown): WeatherForecastDay[] {
  const daily = asRecord(asRecord(data)?.daily)
  const dates = Array.isArray(daily?.time) ? daily.time : []
  const codes = Array.isArray(daily?.weather_code) ? daily.weather_code : []
  const highs = Array.isArray(daily?.temperature_2m_max)
    ? daily.temperature_2m_max
    : []
  const lows = Array.isArray(daily?.temperature_2m_min)
    ? daily.temperature_2m_min
    : []
  const precipitation = Array.isArray(daily?.precipitation_probability_max)
    ? daily.precipitation_probability_max
    : []

  return dates.slice(0, 5).flatMap((date, index) => {
    const normalizedDate = toOptionalString(date)
    const high = toFiniteNumber(highs[index])
    const low = toFiniteNumber(lows[index])
    if (!normalizedDate || high === null || low === null) {
      return []
    }

    return [
      {
        date: normalizedDate,
        condition: weatherCodeToCondition(toFiniteNumber(codes[index])),
        temperatureMax: high,
        temperatureMin: low,
        precipitationProbability: toNullableNumber(precipitation[index]),
      },
    ]
  })
}

export async function runWeatherCardTool(
  input: DisplayWeatherInput,
  config: Pick<GenerativeUiToolConfig, "fetchImpl"> = {}
): Promise<WeatherCardOutput> {
  const fetchImpl = config.fetchImpl ?? fetch
  const location = input.location.trim()
  const unit = normalizeWeatherUnit(input.unit)
  const geocodingUrl = new URL(OPEN_METEO_GEOCODING_URL)
  geocodingUrl.searchParams.set("name", location)
  geocodingUrl.searchParams.set("count", "1")
  geocodingUrl.searchParams.set("language", "en")
  geocodingUrl.searchParams.set("format", "json")

  const geocodingData = asRecord(
    await fetchJson({ fetchImpl, url: geocodingUrl })
  )
  const geocodingResult = Array.isArray(geocodingData?.results)
    ? asRecord(geocodingData.results[0])
    : null
  const latitude = toFiniteNumber(geocodingResult?.latitude)
  const longitude = toFiniteNumber(geocodingResult?.longitude)
  if (!geocodingResult || latitude === null || longitude === null) {
    throw new Error(`Unable to resolve weather location: ${location}.`)
  }

  const forecastUrl = buildForecastUrl({ latitude, longitude, unit })
  const forecastData = asRecord(
    await fetchJson({ fetchImpl, url: forecastUrl })
  )
  const current = asRecord(forecastData?.current)
  const temperature = toFiniteNumber(current?.temperature_2m)
  const observedAt = toOptionalString(current?.time)
  const forecast = normalizeWeatherForecast(forecastData)
  if (temperature === null || !observedAt || forecast.length === 0) {
    throw new Error("Open-Meteo forecast data is unavailable.")
  }

  return {
    location,
    resolvedLocation: getResolvedLocation(geocodingResult) || location,
    latitude,
    longitude,
    unit,
    condition: weatherCodeToCondition(toFiniteNumber(current?.weather_code)),
    temperature,
    feelsLike: toNullableNumber(current?.apparent_temperature),
    humidity: toNullableNumber(current?.relative_humidity_2m),
    windSpeed: toNullableNumber(current?.wind_speed_10m),
    windDirection: toNullableNumber(current?.wind_direction_10m),
    observedAt,
    forecast,
    provider: "open-meteo",
    sourceUrl: forecastUrl.toString(),
  }
}

function getRangeHistoryLimit(range: StockRange): number {
  if (range === "5d") return 5
  if (range === "6m") return 126
  if (range === "1y") return 250
  return 22
}

function getRangeStartDate(range: StockRange): string {
  const days =
    range === "5d" ? 14 : range === "6m" ? 210 : range === "1y" ? 410 : 45
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - days)
  return start.toISOString().slice(0, 10)
}

function normalizeHistoryPoints(
  value: unknown,
  limit: number
): StockPricePoint[] {
  const record = asRecord(value)
  const rows = Array.isArray(record?.rows)
    ? record.rows
    : Array.isArray(record?.historical)
      ? record.historical
      : []

  return rows
    .flatMap((row) => {
      const rowRecord = asRecord(row)
      const date = toOptionalString(rowRecord?.date)
      const close = toFiniteNumber(rowRecord?.close)
      return date && close !== null ? [{ date, close }] : []
    })
    .slice(-limit)
}

function getFirstArrayRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return asRecord(value[0])
  }

  return asRecord(value)
}

function normalizeQuoteOutput(params: {
  data: unknown
  fallbackSymbol: string
  provider: StockCardOutput["provider"]
  range: StockRange
  history: StockPricePoint[]
  sourceUrl?: string
}): StockCardOutput {
  const quote = getFirstArrayRecord(params.data)
  if (!quote) {
    throw new Error("Stock quote data is unavailable.")
  }

  const price =
    toFiniteNumber(quote.price) ??
    toFiniteNumber(quote.close) ??
    toFiniteNumber(quote.Close)
  if (price === null) {
    throw new Error("Stock quote price is unavailable.")
  }

  const symbol =
    toOptionalString(quote.symbol) ??
    toOptionalString(quote.Symbol) ??
    params.fallbackSymbol
  const open = toNullableNumber(quote.open ?? quote.Open)
  const high = toNullableNumber(quote.dayHigh ?? quote.high ?? quote.High)
  const low = toNullableNumber(quote.dayLow ?? quote.low ?? quote.Low)
  const change =
    toNullableNumber(quote.change ?? quote.changeInPrice) ??
    (open !== null ? price - open : null)
  const changePercent =
    toNullableNumber(quote.changesPercentage ?? quote.changePercent) ??
    (change !== null && open !== null && open !== 0
      ? (change / open) * 100
      : null)
  const timestamp = toFiniteNumber(quote.timestamp)
  const stooqDate = toOptionalString(quote.date ?? quote.Date)
  const stooqTime = toOptionalString(quote.time ?? quote.Time)

  return {
    symbol: symbol.toUpperCase(),
    name: toOptionalString(quote.name ?? quote.Name),
    currency: toOptionalString(quote.currency),
    price,
    open,
    high,
    low,
    volume: toNullableNumber(quote.volume ?? quote.Volume),
    dayChange: change,
    dayChangePercent: changePercent,
    asOf:
      timestamp !== null
        ? new Date(timestamp * 1000).toISOString()
        : stooqDate && stooqTime
          ? `${stooqDate} ${stooqTime}`
          : (stooqDate ?? new Date().toISOString()),
    delayed:
      params.provider === "stooq" ||
      (typeof quote.delayed === "boolean" ? quote.delayed : false),
    provider: params.provider,
    range: params.range,
    history: params.history,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
  }
}

function normalizeStockProvider(
  value: unknown,
  fallback: StockCardOutput["provider"]
): StockCardOutput["provider"] {
  return value === "fmp" || value === "stooq" ? value : fallback
}

async function fetchFinanceOutput(params: {
  provider: "fmp" | "stooq"
  operation: "quote" | "historical_prices"
  symbol: string
  range: StockRange
  fmpApiKey?: string
  fetchImpl?: typeof fetch
}) {
  return runFinanceDataOperation(
    {
      operation: params.operation,
      provider: params.provider,
      symbol: params.symbol,
      from:
        params.operation === "historical_prices"
          ? getRangeStartDate(params.range)
          : undefined,
      limit:
        params.operation === "historical_prices"
          ? getRangeHistoryLimit(params.range)
          : undefined,
    },
    {
      fmpApiKey: params.fmpApiKey,
      fetchImpl: params.fetchImpl,
    }
  )
}

async function fetchStockBundle(params: {
  provider: "fmp" | "stooq"
  symbol: string
  range: StockRange
  fmpApiKey?: string
  fetchImpl?: typeof fetch
}) {
  const quote = await fetchFinanceOutput({
    ...params,
    operation: "quote",
  })
  if (!quote.output) {
    throw new Error(quote.error?.message ?? "Stock quote data is unavailable.")
  }

  const historyResult = await fetchFinanceOutput({
    ...params,
    operation: "historical_prices",
  })
  const fallbackHistoryResult =
    !historyResult.output && params.provider === "fmp"
      ? await fetchFinanceOutput({
          ...params,
          provider: "stooq",
          operation: "historical_prices",
        })
      : null

  return {
    quote: quote.output,
    history: historyResult.output ?? fallbackHistoryResult?.output,
  }
}

export async function runStockCardTool(
  input: DisplayStockInput,
  config: GenerativeUiToolConfig = {}
): Promise<StockCardOutput> {
  const symbol = input.symbol.replace(/\s+/g, "").toUpperCase()
  const range = normalizeStockRange(input.range)
  if (!symbol) {
    throw new Error("Stock symbol is required.")
  }

  const providers: ("fmp" | "stooq")[] = config.fmpApiKey?.trim()
    ? ["fmp", "stooq"]
    : ["stooq"]
  let lastError: unknown

  for (const provider of providers) {
    try {
      const bundle = await fetchStockBundle({
        provider,
        symbol,
        range,
        fmpApiKey: config.fmpApiKey,
        fetchImpl: config.fetchImpl,
      })
      const history = normalizeHistoryPoints(
        bundle.history?.data,
        getRangeHistoryLimit(range)
      )
      const actualProvider = normalizeStockProvider(
        bundle.quote.provider,
        provider
      )
      const sourceUrl =
        bundle.quote.requestUrl ?? bundle.quote.sources[0]?.url ?? undefined

      return normalizeQuoteOutput({
        data: bundle.quote.data,
        fallbackSymbol: symbol,
        provider: actualProvider,
        range,
        history,
        sourceUrl,
      })
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Stock data is unavailable.")
}

export function createAiSdkGenerativeUiTools(
  config: GenerativeUiToolConfig = {}
) {
  return {
    display_weather: tool({
      description:
        "Display a weather card for a direct weather request. Use for current conditions and short forecasts for one location. Default to Fahrenheit unless the user asks for Celsius.",
      inputSchema: weatherInputSchema,
      execute: async (input) => runWeatherCardTool(input, config),
    }),
    display_stock: tool({
      description:
        "Display a stock quote card for a simple quote, stock price, or compact chart request. Use finance_data instead for financial statements, SEC facts, valuation, calculations, or deeper research. This is informational only, not investment advice.",
      inputSchema: stockInputSchema,
      execute: async (input) => runStockCardTool(input, config),
    }),
  }
}

export function isAiSdkGenerativeUiToolName(
  value: unknown
): value is Extract<ToolName, GenerativeUiToolName> {
  return (
    value === DISPLAY_WEATHER_TOOL_NAME || value === DISPLAY_STOCK_TOOL_NAME
  )
}

export function getAiSdkGenerativeUiToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkGenerativeUiToolCallMetadata | null {
  if (!part || !isAiSdkGenerativeUiToolName(part.toolName)) {
    return null
  }

  if (part.toolName === DISPLAY_WEATHER_TOOL_NAME) {
    const input = normalizeWeatherInput(part.input)
    return {
      callId: part.toolCallId,
      toolName: part.toolName,
      label: input ? `Weather: ${input.location}` : "Weather",
      ...(input ? { query: input.location } : {}),
      operation: "display_weather",
      provider: "open-meteo",
    }
  }

  const input = normalizeStockInput(part.input)
  return {
    callId: part.toolCallId,
    toolName: part.toolName,
    label: input ? `Stock: ${input.symbol}` : "Stock quote",
    ...(input ? { query: input.symbol } : {}),
    operation: "display_stock",
    provider: "finance_data",
  }
}

export function getAiSdkGenerativeUiToolCallPart(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): GenerativeUiMessagePart | null {
  if (!part || !isAiSdkGenerativeUiToolName(part.toolName)) {
    return null
  }

  if (part.toolName === DISPLAY_WEATHER_TOOL_NAME) {
    const input = normalizeWeatherInput(part.input)
    return input
      ? {
          type: "tool-display_weather",
          toolCallId: part.toolCallId,
          state: "input-available",
          input,
        }
      : null
  }

  const input = normalizeStockInput(part.input)
  return input
    ? {
        type: "tool-display_stock",
        toolCallId: part.toolCallId,
        state: "input-available",
        input,
      }
    : null
}

export function getAiSdkGenerativeUiToolResultPart(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
        output: unknown
      }
    | undefined
): GenerativeUiMessagePart | null {
  if (!part || !isAiSdkGenerativeUiToolName(part.toolName)) {
    return null
  }

  if (part.toolName === DISPLAY_WEATHER_TOOL_NAME) {
    const input = normalizeWeatherInput(part.input)
    return input
      ? {
          type: "tool-display_weather",
          toolCallId: part.toolCallId,
          state: "output-available",
          input,
          output: part.output as WeatherCardOutput,
        }
      : null
  }

  const input = normalizeStockInput(part.input)
  return input
    ? {
        type: "tool-display_stock",
        toolCallId: part.toolCallId,
        state: "output-available",
        input,
        output: part.output as StockCardOutput,
      }
    : null
}

function getErrorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Tool execution failed."

  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=REDACTED")
    .replace(/api_key=[^&\s]+/gi, "api_key=REDACTED")
    .slice(0, 500)
}

export function getAiSdkGenerativeUiToolErrorPart(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
        error: unknown
      }
    | undefined
): GenerativeUiMessagePart | null {
  if (!part || !isAiSdkGenerativeUiToolName(part.toolName)) {
    return null
  }

  if (part.toolName === DISPLAY_WEATHER_TOOL_NAME) {
    const input = normalizeWeatherInput(part.input)
    return {
      type: "tool-display_weather",
      toolCallId: part.toolCallId,
      state: "output-error",
      ...(input ? { input } : {}),
      errorText: getErrorText(part.error),
    }
  }

  const input = normalizeStockInput(part.input)
  return {
    type: "tool-display_stock",
    toolCallId: part.toolCallId,
    state: "output-error",
    ...(input ? { input } : {}),
    errorText: getErrorText(part.error),
  }
}

export function getAiSdkGenerativeUiToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkGenerativeUiToolResultMetadata | null {
  if (!part || !isAiSdkGenerativeUiToolName(part.toolName)) {
    return null
  }

  if (part.toolName === DISPLAY_WEATHER_TOOL_NAME) {
    const output = part.output as Partial<WeatherCardOutput>
    const sources = output.sourceUrl
      ? [
          createSource({
            prefix: "generative-ui-weather",
            title: "Open-Meteo forecast",
            url: output.sourceUrl,
          }),
        ]
      : []

    return {
      callId: part.toolCallId,
      toolName: part.toolName,
      status: "success",
      sources,
      operation: "display_weather",
      provider: "open-meteo",
    }
  }

  const output = part.output as Partial<StockCardOutput>
  const provider = output.provider
  const sources = output.sourceUrl
    ? [
        createSource({
          prefix: "generative-ui-stock",
          title: provider === "fmp" ? "Financial Modeling Prep" : "Stooq",
          url: output.sourceUrl,
        }),
      ]
    : []

  return {
    callId: part.toolCallId,
    toolName: part.toolName,
    status: "success",
    sources,
    operation: "display_stock",
    provider,
  }
}
