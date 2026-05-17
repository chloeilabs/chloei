import { asRecord, asString } from "@/lib/cast"
import { parseHttpErrorResponse } from "@/lib/http-error"
import {
  AGENT_RUN_STATUSES,
  type AgentRunStatus,
  type AgentStreamEvent,
  type CodeExecutionArtifactMetadata,
  type GenerativeUiMessagePart,
  isToolName,
  type StockCardOutput,
  type StockPricePoint,
  type StockRange,
  type StockToolInput,
  type TimelineCardOutput,
  type TimelineEvent,
  type TimelineToolInput,
  type WeatherCardOutput,
  type WeatherForecastDay,
  type WeatherToolInput,
  type WeatherUnit,
} from "@/lib/shared"

const AGENT_RUN_STATUS_SET: ReadonlySet<AgentRunStatus> = new Set(
  AGENT_RUN_STATUSES
)
const WEATHER_UNIT_SET: ReadonlySet<WeatherUnit> = new Set([
  "fahrenheit",
  "celsius",
])
const STOCK_RANGE_SET: ReadonlySet<StockRange> = new Set([
  "5d",
  "1m",
  "6m",
  "1y",
])

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    typeof value === "string" &&
    AGENT_RUN_STATUS_SET.has(value as AgentRunStatus)
  )
}

function parseInteractionCheckpointFields(
  record: Record<string, unknown>
): Pick<AgentStreamEvent, "interactionId" | "lastEventId"> | null {
  const nextFields: Pick<AgentStreamEvent, "interactionId" | "lastEventId"> = {}

  if ("interactionId" in record) {
    const interactionId = asString(record.interactionId)?.trim()
    if (!interactionId) {
      return null
    }
    nextFields.interactionId = interactionId
  }

  if ("lastEventId" in record) {
    const lastEventId = asString(record.lastEventId)?.trim()
    if (!lastEventId) {
      return null
    }
    nextFields.lastEventId = lastEventId
  }

  return nextFields
}

function parseOptionalToolMetadata(record: Record<string, unknown>) {
  const parseOptionalString = (key: "operation" | "provider" | "errorCode") => {
    const value = record[key]
    if (value === undefined || value === null) {
      return undefined
    }

    const trimmed = asString(value)?.trim()
    if (!trimmed) {
      return null
    }

    return trimmed
  }

  const operation = parseOptionalString("operation")
  if (operation === null) return null

  const provider = parseOptionalString("provider")
  if (provider === null) return null

  const attempt = record.attempt
  if (
    attempt !== undefined &&
    attempt !== null &&
    (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1)
  ) {
    return null
  }

  const durationMs = record.durationMs
  if (
    durationMs !== undefined &&
    durationMs !== null &&
    (typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0)
  ) {
    return null
  }

  const errorCode = parseOptionalString("errorCode")
  if (errorCode === null) return null

  const retryable = record.retryable
  if (
    retryable !== undefined &&
    retryable !== null &&
    typeof retryable !== "boolean"
  ) {
    return null
  }

  const artifactManifest = parseArtifactManifest(record.artifactManifest)
  if (artifactManifest === null) return null

  return {
    ...(operation ? { operation } : {}),
    ...(provider ? { provider } : {}),
    ...(typeof attempt === "number" ? { attempt } : {}),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(artifactManifest?.length ? { artifactManifest } : {}),
  }
}

function parseArtifactManifest(
  value: unknown
): CodeExecutionArtifactMetadata[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (!Array.isArray(value) || value.length > 50) {
    return null
  }

  const artifacts: CodeExecutionArtifactMetadata[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) {
      return null
    }

    const artifactPath = asString(record.path)?.trim()
    const artifactSegments = artifactPath?.replaceAll("\\", "/").split("/")
    const sizeBytes = record.sizeBytes
    const artifactUrlValue = record.url
    const artifactUrl = asString(artifactUrlValue)?.trim()
    const hasInvalidArtifactUrl =
      artifactUrlValue !== undefined &&
      artifactUrlValue !== null &&
      artifactUrl?.startsWith("/api/agent/artifacts/") !== true
    if (
      !artifactPath ||
      artifactPath.startsWith("/") ||
      artifactSegments?.includes("..") ||
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 0 ||
      hasInvalidArtifactUrl
    ) {
      return null
    }

    artifacts.push({
      path: artifactPath,
      sizeBytes,
      ...(artifactUrl ? { url: artifactUrl } : {}),
    })
  }

  return artifacts
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }

  return asFiniteNumber(value)
}

function parseOptionalStringField(
  record: Record<string, unknown>,
  key: string
): string | null | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }

  const normalized = asString(value)?.trim()
  if (!normalized) {
    return null
  }

  return normalized
}

function parseWeatherToolInput(value: unknown): WeatherToolInput | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const location = asString(record.location)?.trim()
  if (!location) {
    return null
  }

  const unit = record.unit
  if (
    unit !== undefined &&
    unit !== null &&
    !WEATHER_UNIT_SET.has(unit as WeatherUnit)
  ) {
    return null
  }

  return {
    location,
    ...(WEATHER_UNIT_SET.has(unit as WeatherUnit)
      ? { unit: unit as WeatherUnit }
      : {}),
  }
}

function parseStockToolInput(value: unknown): StockToolInput | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const symbol = asString(record.symbol)?.trim()
  if (!symbol) {
    return null
  }

  const range = record.range
  if (
    range !== undefined &&
    range !== null &&
    !STOCK_RANGE_SET.has(range as StockRange)
  ) {
    return null
  }

  return {
    symbol,
    ...(STOCK_RANGE_SET.has(range as StockRange)
      ? { range: range as StockRange }
      : {}),
  }
}

function parseWeatherForecastDay(value: unknown): WeatherForecastDay | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const date = asString(record.date)?.trim()
  const condition = asString(record.condition)?.trim()
  const temperatureMax = asFiniteNumber(record.temperatureMax)
  const temperatureMin = asFiniteNumber(record.temperatureMin)
  const precipitationProbability =
    record.precipitationProbability === null
      ? null
      : parseOptionalFiniteNumber(record, "precipitationProbability")

  if (
    !date ||
    !condition ||
    temperatureMax === null ||
    temperatureMin === null ||
    precipitationProbability === null
  ) {
    return null
  }

  return {
    date,
    condition,
    temperatureMax,
    temperatureMin,
    ...(precipitationProbability !== undefined
      ? { precipitationProbability }
      : {}),
  }
}

function parseWeatherCardOutput(value: unknown): WeatherCardOutput | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const location = asString(record.location)?.trim()
  const resolvedLocation = parseOptionalStringField(record, "resolvedLocation")
  const latitude = asFiniteNumber(record.latitude)
  const longitude = asFiniteNumber(record.longitude)
  const unit = record.unit
  const condition = asString(record.condition)?.trim()
  const temperature = asFiniteNumber(record.temperature)
  const feelsLike =
    record.feelsLike === null
      ? null
      : parseOptionalFiniteNumber(record, "feelsLike")
  const humidity =
    record.humidity === null
      ? null
      : parseOptionalFiniteNumber(record, "humidity")
  const windSpeed =
    record.windSpeed === null
      ? null
      : parseOptionalFiniteNumber(record, "windSpeed")
  const windDirection =
    record.windDirection === null
      ? null
      : parseOptionalFiniteNumber(record, "windDirection")
  const observedAt = asString(record.observedAt)?.trim()
  const provider = record.provider
  const sourceUrl = parseOptionalStringField(record, "sourceUrl")
  const forecast = Array.isArray(record.forecast)
    ? record.forecast.flatMap((day) => {
        const parsed = parseWeatherForecastDay(day)
        return parsed ? [parsed] : []
      })
    : null

  if (
    !location ||
    resolvedLocation === null ||
    latitude === null ||
    longitude === null ||
    !WEATHER_UNIT_SET.has(unit as WeatherUnit) ||
    !condition ||
    temperature === null ||
    feelsLike === null ||
    humidity === null ||
    windSpeed === null ||
    windDirection === null ||
    !observedAt ||
    provider !== "open-meteo" ||
    sourceUrl === null ||
    forecast === null ||
    forecast.length === 0 ||
    forecast.length > 7
  ) {
    return null
  }

  return {
    location,
    ...(resolvedLocation ? { resolvedLocation } : {}),
    latitude,
    longitude,
    unit: unit as WeatherUnit,
    condition,
    temperature,
    ...(feelsLike !== undefined ? { feelsLike } : {}),
    ...(humidity !== undefined ? { humidity } : {}),
    ...(windSpeed !== undefined ? { windSpeed } : {}),
    ...(windDirection !== undefined ? { windDirection } : {}),
    observedAt,
    forecast,
    provider,
    ...(sourceUrl ? { sourceUrl } : {}),
  }
}

function parseStockPricePoint(value: unknown): StockPricePoint | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const date = asString(record.date)?.trim()
  const close = asFiniteNumber(record.close)
  if (!date || close === null) {
    return null
  }

  return { date, close }
}

function parseStockCardOutput(value: unknown): StockCardOutput | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const symbol = asString(record.symbol)?.trim()
  const name = parseOptionalStringField(record, "name")
  const currency = parseOptionalStringField(record, "currency")
  const price = asFiniteNumber(record.price)
  const open =
    record.open === null ? null : parseOptionalFiniteNumber(record, "open")
  const high =
    record.high === null ? null : parseOptionalFiniteNumber(record, "high")
  const low =
    record.low === null ? null : parseOptionalFiniteNumber(record, "low")
  const volume =
    record.volume === null ? null : parseOptionalFiniteNumber(record, "volume")
  const dayChange =
    record.dayChange === null
      ? null
      : parseOptionalFiniteNumber(record, "dayChange")
  const dayChangePercent =
    record.dayChangePercent === null
      ? null
      : parseOptionalFiniteNumber(record, "dayChangePercent")
  const asOf = asString(record.asOf)?.trim()
  const delayed = record.delayed
  const provider = record.provider
  const range = record.range
  const sourceUrl = parseOptionalStringField(record, "sourceUrl")
  const history = Array.isArray(record.history)
    ? record.history.flatMap((point) => {
        const parsed = parseStockPricePoint(point)
        return parsed ? [parsed] : []
      })
    : null

  if (
    !symbol ||
    name === null ||
    currency === null ||
    price === null ||
    open === null ||
    high === null ||
    low === null ||
    volume === null ||
    dayChange === null ||
    dayChangePercent === null ||
    !asOf ||
    typeof delayed !== "boolean" ||
    (provider !== "fmp" && provider !== "stooq") ||
    !STOCK_RANGE_SET.has(range as StockRange) ||
    sourceUrl === null ||
    history === null ||
    history.length > 250
  ) {
    return null
  }

  return {
    symbol,
    ...(name ? { name } : {}),
    ...(currency ? { currency } : {}),
    price,
    ...(open !== undefined ? { open } : {}),
    ...(high !== undefined ? { high } : {}),
    ...(low !== undefined ? { low } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(dayChange !== undefined ? { dayChange } : {}),
    ...(dayChangePercent !== undefined ? { dayChangePercent } : {}),
    asOf,
    delayed,
    provider,
    range: range as StockRange,
    history,
    ...(sourceUrl ? { sourceUrl } : {}),
  }
}

function parseTimelineEvent(value: unknown): TimelineEvent | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const date = asString(record.date)?.trim()
  const label = asString(record.label)?.trim()
  if (!date || !label) {
    return null
  }

  const description = parseOptionalStringField(record, "description")
  if (description === null) {
    return null
  }

  const sourceUrl = parseOptionalStringField(record, "sourceUrl")
  if (sourceUrl === null) {
    return null
  }

  return {
    date,
    label,
    ...(description ? { description } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  }
}

function parseTimelineToolInput(value: unknown): TimelineToolInput | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const title = asString(record.title)?.trim()
  if (!title) {
    return null
  }

  const subtitle = parseOptionalStringField(record, "subtitle")
  if (subtitle === null) {
    return null
  }

  const rawEvents = Array.isArray(record.events) ? record.events : null
  if (!rawEvents || rawEvents.length === 0 || rawEvents.length > 40) {
    return null
  }

  const events: TimelineEvent[] = []
  for (const entry of rawEvents) {
    const parsed = parseTimelineEvent(entry)
    if (!parsed) {
      return null
    }
    events.push(parsed)
  }

  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    events,
  }
}

function parseTimelineCardOutput(value: unknown): TimelineCardOutput | null {
  const input = parseTimelineToolInput(value)
  return input
    ? {
        title: input.title,
        ...(input.subtitle ? { subtitle: input.subtitle } : {}),
        events: input.events,
      }
    : null
}

function parseGenerativeUiPart(value: unknown): GenerativeUiMessagePart | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const type = asString(record.type)
  const toolCallId = asString(record.toolCallId)?.trim()
  const state = asString(record.state)
  if (!toolCallId) {
    return null
  }

  if (type === "tool-display_weather") {
    if (state === "input-available") {
      const input = parseWeatherToolInput(record.input)
      return input ? { type, toolCallId, state, input } : null
    }

    if (state === "output-available") {
      const input = parseWeatherToolInput(record.input)
      const output = parseWeatherCardOutput(record.output)
      return input && output ? { type, toolCallId, state, input, output } : null
    }

    if (state === "output-error") {
      const input =
        record.input === undefined || record.input === null
          ? undefined
          : parseWeatherToolInput(record.input)
      const errorText = asString(record.errorText)?.trim()
      if (input === null || !errorText) {
        return null
      }
      return { type, toolCallId, state, ...(input ? { input } : {}), errorText }
    }
  }

  if (type === "tool-display_stock") {
    if (state === "input-available") {
      const input = parseStockToolInput(record.input)
      return input ? { type, toolCallId, state, input } : null
    }

    if (state === "output-available") {
      const input = parseStockToolInput(record.input)
      const output = parseStockCardOutput(record.output)
      return input && output ? { type, toolCallId, state, input, output } : null
    }

    if (state === "output-error") {
      const input =
        record.input === undefined || record.input === null
          ? undefined
          : parseStockToolInput(record.input)
      const errorText = asString(record.errorText)?.trim()
      if (input === null || !errorText) {
        return null
      }
      return { type, toolCallId, state, ...(input ? { input } : {}), errorText }
    }
  }

  if (type === "tool-display_timeline") {
    if (state === "input-available") {
      const input = parseTimelineToolInput(record.input)
      return input ? { type, toolCallId, state, input } : null
    }

    if (state === "output-available") {
      const input = parseTimelineToolInput(record.input)
      const output = parseTimelineCardOutput(record.output)
      return input && output ? { type, toolCallId, state, input, output } : null
    }

    if (state === "output-error") {
      const input =
        record.input === undefined || record.input === null
          ? undefined
          : parseTimelineToolInput(record.input)
      const errorText = asString(record.errorText)?.trim()
      if (input === null || !errorText) {
        return null
      }
      return { type, toolCallId, state, ...(input ? { input } : {}), errorText }
    }
  }

  return null
}

export function parseStreamEventLine(line: string): AgentStreamEvent | null {
  if (!line) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  const record = asRecord(parsed)
  if (!record) {
    return null
  }

  const type = asString(record.type)
  if (!type) {
    return null
  }

  const checkpointFields = parseInteractionCheckpointFields(record)
  if (!checkpointFields) {
    return null
  }

  if (type === "text_delta") {
    const delta = asString(record.delta)
    if (delta === null) {
      return null
    }

    return { type, delta, ...checkpointFields }
  }

  if (type === "reasoning_delta") {
    const delta = asString(record.delta)
    if (delta === null) {
      return null
    }

    return { type, delta, ...checkpointFields }
  }

  if (type === "tool_call") {
    const callIdRaw = record.callId
    const callId = asString(callIdRaw)
    if (callIdRaw !== null && callId === null) {
      return null
    }

    const toolName = record.toolName
    if (!isToolName(toolName)) {
      return null
    }

    const label = asString(record.label)?.trim()
    if (!label) {
      return null
    }

    const queryValue = record.query
    const query = asString(queryValue)?.trim()
    if (
      queryValue !== undefined &&
      queryValue !== null &&
      asString(queryValue) === null
    ) {
      return null
    }

    const toolMetadata = parseOptionalToolMetadata(record)
    if (!toolMetadata) {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      toolName,
      label,
      ...(query ? { query } : {}),
      ...toolMetadata,
      ...checkpointFields,
    }
  }

  if (type === "tool_result") {
    const callIdRaw = record.callId
    const callId = asString(callIdRaw)
    if (callIdRaw !== null && callId === null) {
      return null
    }

    const status = asString(record.status)
    if (status !== "success" && status !== "error") {
      return null
    }

    const toolName = record.toolName
    if (toolName !== undefined && toolName !== null && !isToolName(toolName)) {
      return null
    }

    const toolMetadata = parseOptionalToolMetadata(record)
    if (!toolMetadata) {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      ...(isToolName(toolName) ? { toolName } : {}),
      status,
      ...toolMetadata,
      ...checkpointFields,
    }
  }

  if (type === "source") {
    const sourceRecord = asRecord(record.source)
    if (!sourceRecord) {
      return null
    }

    const id = asString(sourceRecord.id)?.trim()
    const url = asString(sourceRecord.url)?.trim()
    const title = asString(sourceRecord.title)?.trim()
    if (!id || !url || !title) {
      return null
    }

    return {
      type,
      source: {
        id,
        url,
        title,
      },
      ...checkpointFields,
    }
  }

  if (type === "generative_ui") {
    const part = parseGenerativeUiPart(record.part)
    return part ? { type, part, ...checkpointFields } : null
  }

  if (type === "agent_status") {
    const status = record.status
    if (!isAgentRunStatus(status)) {
      return null
    }

    return {
      type,
      status,
      ...checkpointFields,
    }
  }

  return null
}

export async function getResponseErrorMessage(
  response: Response
): Promise<string> {
  return (await parseHttpErrorResponse(response)).message
}

export async function readResponseStreamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string, appendNewline: boolean) => void
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    const chunk = decoder.decode(value, { stream: true })
    if (!chunk) {
      continue
    }

    lineBuffer += chunk

    const lines = lineBuffer.split("\n")
    lineBuffer = lines.pop() ?? ""

    for (const line of lines) {
      onLine(line, true)
    }
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    lineBuffer += finalChunk
  }

  if (lineBuffer.length > 0) {
    onLine(lineBuffer, false)
  }
}
