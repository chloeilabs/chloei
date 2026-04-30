const STOOQ_BASE_URL = "https://stooq.com/q/l/"

interface StooqHistoricalPricesInput {
  from?: string
  limit?: number
  symbol?: string
  to?: string
}

function requireSymbol(input: StooqHistoricalPricesInput): string {
  if (typeof input.symbol !== "string" || !input.symbol.trim()) {
    throw new Error("historical_prices requires `symbol`.")
  }

  return input.symbol.trim()
}

function normalizeTickerSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

function normalizeLimit(input: StooqHistoricalPricesInput, fallback: number) {
  return Math.max(1, Math.min(250, input.limit ?? fallback))
}

function normalizeStooqSymbol(symbol: string): string {
  const normalized = normalizeTickerSymbol(symbol).toLowerCase()
  if (!normalized) {
    throw new Error("quote requires `symbol`.")
  }

  return normalized.includes(".") ? normalized : `${normalized}.us`
}

export function buildStooqQuoteUrl(symbol: string): URL {
  const url = new URL(STOOQ_BASE_URL)
  url.searchParams.set("s", normalizeStooqSymbol(symbol))
  url.searchParams.set("f", "sd2t2ohlcvn")
  url.searchParams.set("h", "")
  url.searchParams.set("e", "csv")
  return url
}

function toStooqDate(value: string): string {
  return value.replaceAll("-", "")
}

export function buildStooqHistoricalPricesUrl(
  input: StooqHistoricalPricesInput
): URL {
  const url = new URL("https://stooq.com/q/d/l/")
  url.searchParams.set("s", normalizeStooqSymbol(requireSymbol(input)))
  url.searchParams.set("i", "d")
  if (input.from) {
    url.searchParams.set("d1", toStooqDate(input.from))
  }
  if (input.to) {
    url.searchParams.set("d2", toStooqDate(input.to))
  }
  return url
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let quoted = false

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      continue
    }

    if (char === "," && !quoted) {
      values.push(current)
      current = ""
      continue
    }

    current += char
  }

  values.push(current)
  return values
}

function toNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseStooqQuoteCsv(csv: string) {
  const lines = csv
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  const headers = lines[0] ? parseCsvLine(lines[0]) : []
  const row = lines[1] ? parseCsvLine(lines[1]) : []
  const record = Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ""])
  )
  const close = toNumber(record.Close ?? "")

  if (!record.Symbol || record.Symbol === "N/D" || close === null) {
    throw Object.assign(new Error("Stooq quote data is unavailable."), {
      code: "QUOTE_UNAVAILABLE",
      retryable: true,
    })
  }

  return {
    symbol: record.Symbol,
    date: record.Date,
    time: record.Time,
    open: toNumber(record.Open ?? ""),
    high: toNumber(record.High ?? ""),
    low: toNumber(record.Low ?? ""),
    close,
    volume: toNumber(record.Volume ?? ""),
    name: record.Name,
    delayed: true,
  }
}

export function parseStooqHistoricalPricesCsv(
  csv: string,
  input: StooqHistoricalPricesInput
) {
  const lines = csv
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  const headers = lines[0] ? parseCsvLine(lines[0]) : []
  const rows = lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line)
    const record = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""])
    )
    const close = toNumber(record.Close ?? "")
    if (!record.Date || close === null) {
      return []
    }

    return [
      {
        date: record.Date,
        open: toNumber(record.Open ?? ""),
        high: toNumber(record.High ?? ""),
        low: toNumber(record.Low ?? ""),
        close,
        volume: toNumber(record.Volume ?? ""),
      },
    ]
  })

  if (rows.length === 0) {
    throw Object.assign(new Error("Stooq historical prices are unavailable."), {
      code: "HISTORICAL_PRICES_UNAVAILABLE",
      retryable: true,
    })
  }

  const limit = normalizeLimit(input, 30)
  return {
    symbol: normalizeStooqSymbol(requireSymbol(input)).toUpperCase(),
    interval: "1d",
    rows: rows.slice(-limit),
    rowCount: Math.min(rows.length, limit),
    totalRowsAvailable: rows.length,
    truncated: rows.length > limit,
  }
}
