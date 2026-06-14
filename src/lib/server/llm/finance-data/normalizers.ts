/**
 * Shared input normalizers for the finance_data and sec_filings tools.
 */

/** Collapse internal whitespace and upper-case a ticker symbol. */
export function normalizeTickerSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

/**
 * Read a required string field from a finance/SEC tool input. Throws a
 * non-retryable `INVALID_INPUT` error (consumed by the tools' catch handlers)
 * when the field is missing or blank.
 */
export function requireField<T extends { operation: string }>(
  input: T,
  field: keyof T
): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(
      new Error(`${input.operation} requires \`${String(field)}\`.`),
      { code: "INVALID_INPUT", retryable: false }
    )
  }

  return value.trim()
}
