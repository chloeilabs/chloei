/**
 * SEC/EDGAR endpoint constants and URL builders shared by the finance_data and
 * sec_filings tools.
 */

const SEC_COMPANY_FACTS_BASE_URL = "https://data.sec.gov/api/xbrl/companyfacts"
const SEC_COMPANY_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions"
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

/** Normalize a CIK to its canonical 10-digit zero-padded form. */
export function normalizeCik(cik: string): string {
  const digits = cik.replace(/\D/g, "")
  if (!digits) {
    throw Object.assign(new Error("A numeric CIK is required."), {
      code: "INVALID_INPUT",
      retryable: false,
    })
  }

  return digits.padStart(10, "0")
}

export function buildSecCompanyFactsUrl(cik: string): URL {
  return new URL(`${SEC_COMPANY_FACTS_BASE_URL}/CIK${normalizeCik(cik)}.json`)
}

export function buildSecSubmissionsUrl(cik: string): URL {
  return new URL(
    `${SEC_COMPANY_SUBMISSIONS_BASE_URL}/CIK${normalizeCik(cik)}.json`
  )
}

export function buildSecSubmissionsContinuationUrl(fileName: string): URL {
  return new URL(`${SEC_COMPANY_SUBMISSIONS_BASE_URL}/${fileName}`)
}

export function buildSecFilingUrl(params: {
  cik: string
  accessionNumber: string
  primaryDocument: string
}): string {
  const cikNumber = Number(normalizeCik(params.cik))
  const accessionDirectory = params.accessionNumber.replaceAll("-", "")
  const primaryDocument = params.primaryDocument.trim().replace(/^\/+/, "")

  return `https://www.sec.gov/Archives/edgar/data/${String(cikNumber)}/${accessionDirectory}/${primaryDocument}`
}

export function buildSecCompanyTickersUrl(): URL {
  return new URL(SEC_COMPANY_TICKERS_URL)
}
