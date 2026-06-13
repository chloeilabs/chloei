import { asRecord, toOptionalString } from "@/lib/cast"

const FINANCE_DATA_MAX_ATTEMPTS = 2
const FINANCE_DATA_DEFAULT_TIMEOUT_MS = 12_000

type FinanceDataRetryProvider = "sec" | "stooq" | "local"

function waitForRetryBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 150 * attempt)
  })
}

export function classifyFinanceDataRetry(params: {
  status?: number
  code?: string
}): boolean {
  if (
    params.status &&
    [408, 409, 425, 429, 500, 502, 503, 504].includes(params.status)
  ) {
    return true
  }

  const code = params.code?.trim().toUpperCase()
  return Boolean(
    code &&
    [
      "ABORT_ERR",
      "ECONNRESET",
      "ETIMEDOUT",
      "FETCH_FAILED",
      "NETWORK_ERROR",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  )
}

async function fetchWithRetry<T>(params: {
  url: URL
  provider: FinanceDataRetryProvider
  headers?: HeadersInit
  fetchImpl: typeof fetch
  timeoutMs?: number
  parse: (response: Response) => Promise<T>
}) {
  let lastError: unknown

  for (let attempt = 1; attempt <= FINANCE_DATA_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Timed out", "AbortError"))
    }, params.timeoutMs ?? FINANCE_DATA_DEFAULT_TIMEOUT_MS)

    try {
      const response = await params.fetchImpl(params.url, {
        headers: params.headers,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const retryable = classifyFinanceDataRetry({ status: response.status })
        if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
          await waitForRetryBackoff(attempt)
          continue
        }

        return {
          ok: false as const,
          attempts: attempt,
          retryable,
          status: response.status,
          code: `HTTP_${String(response.status)}`,
          message: `${params.provider} returned HTTP ${String(response.status)}.`,
        }
      }

      return {
        ok: true as const,
        attempts: attempt,
        data: await params.parse(response),
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error
      const record = asRecord(error)
      const code =
        toOptionalString(record?.code) ??
        (error instanceof DOMException ? error.name : undefined)
      const retryable = classifyFinanceDataRetry({ code })
      if (retryable && attempt < FINANCE_DATA_MAX_ATTEMPTS) {
        await waitForRetryBackoff(attempt)
        continue
      }

      return {
        ok: false as const,
        attempts: attempt,
        retryable,
        code: code ?? "FETCH_FAILED",
        message:
          toOptionalString(record?.message) ??
          (error instanceof Error
            ? error.message
            : "Finance data request failed."),
      }
    }
  }

  return {
    ok: false as const,
    attempts: FINANCE_DATA_MAX_ATTEMPTS,
    retryable: false,
    code: "FETCH_FAILED",
    message:
      lastError instanceof Error
        ? lastError.message
        : "Finance data request failed.",
  }
}

export function fetchJsonWithRetry(params: {
  url: URL
  provider: FinanceDataRetryProvider
  headers?: HeadersInit
  fetchImpl: typeof fetch
  timeoutMs?: number
}) {
  return fetchWithRetry({
    ...params,
    parse: (response) => response.json() as Promise<unknown>,
  })
}

export function fetchTextWithRetry(params: {
  url: URL
  provider: FinanceDataRetryProvider
  headers?: HeadersInit
  fetchImpl: typeof fetch
  timeoutMs?: number
}) {
  return fetchWithRetry({
    ...params,
    parse: (response) => response.text(),
  })
}
