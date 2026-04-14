const PG_SSLMODE_VERIFY_FULL_EQUIVALENTS = new Set([
  "prefer",
  "require",
  "verify-ca",
])

/**
 * Preserve pg's current strict SSL behavior by upgrading ambiguous
 * libpq-style sslmodes to the explicit mode they currently map to.
 *
 * @param {string} connectionString
 * @returns {string}
 */
export function normalizePostgresConnectionString(connectionString) {
  const normalizedConnectionString = connectionString.trim()
  if (!normalizedConnectionString) {
    return normalizedConnectionString
  }

  let databaseUrl

  try {
    databaseUrl = new URL(normalizedConnectionString)
  } catch {
    return normalizedConnectionString
  }

  const sslmode = databaseUrl.searchParams.get("sslmode")?.toLowerCase()
  const useLibpqCompat =
    databaseUrl.searchParams.get("uselibpqcompat")?.toLowerCase() === "true"

  if (
    sslmode &&
    !useLibpqCompat &&
    PG_SSLMODE_VERIFY_FULL_EQUIVALENTS.has(sslmode)
  ) {
    databaseUrl.searchParams.set("sslmode", "verify-full")
  }

  return databaseUrl.toString()
}
