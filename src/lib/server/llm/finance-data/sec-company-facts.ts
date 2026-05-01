import { asRecord, asString } from "@/lib/cast"

export type SecCompanyFactsPeriod = "annual" | "quarter"
export type SecFinancialStatementType = "income" | "balance_sheet" | "cash_flow"

export interface SecFilingSummary {
  form: string
  filingDate: string
  accessionNumber: string
  primaryDocument: string
  url: string
}

interface SecFactEntry {
  concept: string
  label: string
  unit: string
  value: number
  fiscalYear?: number
  fiscalPeriod?: string
  form?: string
  filed?: string
  start?: string
  end?: string
  frame?: string
}

const SEC_INCOME_STATEMENT_CONCEPTS = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  costOfRevenue: [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsSold",
    "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
} as const

const SEC_BALANCE_SHEET_CONCEPTS = {
  cashAndEquivalents: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  currentAssets: ["AssetsCurrent"],
  totalAssets: ["Assets"],
  currentLiabilities: ["LiabilitiesCurrent"],
  totalLiabilities: ["Liabilities"],
  currentDebt: [
    "LongTermDebtCurrent",
    "ShortTermBorrowings",
    "ShortTermBorrowingsCurrent",
    "ShortTermDebtCurrent",
    "LongTermDebtAndFinanceLeaseObligationsCurrent",
  ],
  longTermDebt: [
    "LongTermDebtNoncurrent",
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    "LongTermDebt",
  ],
  stockholdersEquity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  liabilitiesAndEquity: ["LiabilitiesAndStockholdersEquity"],
} as const

const SEC_CASH_FLOW_CONCEPTS = {
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  capitalExpenditures: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ],
  depreciationAndAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationDepletionAndAmortizationExpense",
    "DepreciationAndAmortization",
  ],
  shareBasedCompensation: [
    "ShareBasedCompensation",
    "ShareBasedCompensationArrangementByShareBasedPaymentAwardExpense",
  ],
  dividendsPaid: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
  shareRepurchases: [
    "PaymentsForRepurchaseOfCommonStock",
    "PaymentsForRepurchaseOfEquity",
  ],
  cashPeriodChange: [
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
    "CashAndCashEquivalentsPeriodIncreaseDecrease",
  ],
} as const

const SEC_FINANCIAL_STATEMENT_CONCEPTS = [
  ...Object.values(SEC_INCOME_STATEMENT_CONCEPTS).flat(),
  ...Object.values(SEC_BALANCE_SHEET_CONCEPTS).flat(),
  ...Object.values(SEC_CASH_FLOW_CONCEPTS).flat(),
] as const

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  return value
}

function normalizeSecCik(cik: string): string {
  const digits = cik.replace(/\D/g, "")
  if (!digits) {
    throw new Error("sec_company_facts requires a numeric CIK.")
  }

  return digits.padStart(10, "0")
}

function normalizeTickerSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, "").trim().toUpperCase()
}

function getSecFactEntries(data: unknown, concept: string): SecFactEntry[] {
  const record = asRecord(data)
  const facts = asRecord(record?.facts)
  const usGaap = asRecord(facts?.["us-gaap"])
  const fact = asRecord(usGaap?.[concept])
  const units = asRecord(fact?.units)
  const usdRows = Array.isArray(units?.USD) ? units.USD : []
  const label = toOptionalString(fact?.label) ?? concept

  return usdRows.flatMap((entry): SecFactEntry[] => {
    const row = asRecord(entry)
    const value = toOptionalNumber(row?.val)
    if (value === undefined) {
      return []
    }

    return [
      {
        concept,
        label,
        unit: "USD",
        value,
        fiscalYear: toOptionalNumber(row?.fy),
        fiscalPeriod: toOptionalString(row?.fp),
        form: toOptionalString(row?.form),
        filed: toOptionalString(row?.filed),
        start: toOptionalString(row?.start),
        end: toOptionalString(row?.end),
        frame: toOptionalString(row?.frame),
      },
    ]
  })
}

function isSecFactForPeriod(
  entry: SecFactEntry,
  period: SecCompanyFactsPeriod
): boolean {
  const form = entry.form?.toUpperCase()
  const fiscalPeriod = entry.fiscalPeriod?.toUpperCase()

  if (period === "quarter") {
    return (
      (form === "10-Q" || form === "10-Q/A") &&
      Boolean(fiscalPeriod?.startsWith("Q"))
    )
  }

  return (
    (form === "10-K" || form === "10-K/A" || form === "20-F") &&
    fiscalPeriod === "FY"
  )
}

function getDateSortValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function sortSecFactEntries(entries: SecFactEntry[]): SecFactEntry[] {
  return [...entries].sort((a, b) => {
    const endDelta = getDateSortValue(b.end) - getDateSortValue(a.end)
    if (endDelta !== 0) {
      return endDelta
    }

    return getDateSortValue(b.filed) - getDateSortValue(a.filed)
  })
}

function findLatestSecFact(
  data: unknown,
  concepts: readonly string[],
  period: SecCompanyFactsPeriod
): SecFactEntry | undefined {
  return sortSecFactEntries(
    concepts.flatMap((concept) =>
      getSecFactEntries(data, concept).filter((entry) =>
        isSecFactForPeriod(entry, period)
      )
    )
  )[0]
}

function findMatchingSecFact(
  data: unknown,
  concepts: readonly string[],
  period: SecCompanyFactsPeriod,
  anchor: SecFactEntry
): SecFactEntry | undefined {
  const candidates = sortSecFactEntries(
    concepts.flatMap((concept) =>
      getSecFactEntries(data, concept).filter((entry) =>
        isSecFactForPeriod(entry, period)
      )
    )
  )
  const exactMatch = candidates.find(
    (entry) =>
      entry.fiscalYear === anchor.fiscalYear &&
      entry.fiscalPeriod === anchor.fiscalPeriod &&
      entry.end === anchor.end
  )
  if (exactMatch) {
    return exactMatch
  }

  return candidates.find(
    (entry) =>
      entry.fiscalYear === anchor.fiscalYear &&
      entry.fiscalPeriod === anchor.fiscalPeriod
  )
}

function serializeSecFact(entry: SecFactEntry | undefined) {
  if (!entry) {
    return undefined
  }

  return {
    value: entry.value,
    unit: entry.unit,
    concept: entry.concept,
    label: entry.label,
  }
}

function calculateRatio(numerator: number | undefined, denominator: number) {
  if (typeof numerator !== "number" || denominator === 0) {
    return undefined
  }

  return numerator / denominator
}

function findLatestSecStatementAnchor(
  data: unknown,
  conceptGroups: readonly (readonly string[] | string[])[],
  period: SecCompanyFactsPeriod
): SecFactEntry | undefined {
  return findLatestSecFact(data, conceptGroups.flat(), period)
}

function sumDefinedValues(values: (number | undefined)[]): number | undefined {
  const definedValues = values.filter(
    (value): value is number => typeof value === "number"
  )
  if (definedValues.length === 0) {
    return undefined
  }

  return definedValues.reduce((total, value) => total + value, 0)
}

function summarizeSecIncomeStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: SecCompanyFactsPeriod
}) {
  const revenue = findLatestSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.revenue,
    params.period
  )
  if (!revenue) {
    throw Object.assign(
      new Error("SEC income statement revenue is unavailable."),
      {
        code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
        retryable: false,
      }
    )
  }

  const costOfRevenue = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.costOfRevenue,
    params.period,
    revenue
  )
  const grossProfit =
    findMatchingSecFact(
      params.data,
      SEC_INCOME_STATEMENT_CONCEPTS.grossProfit,
      params.period,
      revenue
    ) ??
    (costOfRevenue
      ? {
          ...revenue,
          concept: "ComputedGrossProfit",
          label: "Revenue less cost of revenue",
          value: revenue.value - costOfRevenue.value,
        }
      : undefined)
  const operatingIncome = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.operatingIncome,
    params.period,
    revenue
  )
  const netIncome = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.netIncome,
    params.period,
    revenue
  )

  return {
    statementType: "income",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeSecCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: revenue.fiscalYear,
    fiscalPeriod: revenue.fiscalPeriod,
    form: revenue.form,
    filed: revenue.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodStart: revenue.start,
    periodEnd: revenue.end,
    reportedFacts: {
      revenue: serializeSecFact(revenue),
      costOfRevenue: serializeSecFact(costOfRevenue),
      grossProfit: serializeSecFact(grossProfit),
      operatingIncome: serializeSecFact(operatingIncome),
      netIncome: serializeSecFact(netIncome),
    },
    computedValues: {
      grossMargin: calculateRatio(grossProfit?.value, revenue.value),
      operatingMargin: calculateRatio(operatingIncome?.value, revenue.value),
      netMargin: calculateRatio(netIncome?.value, revenue.value),
    },
  }
}

function summarizeSecBalanceSheet(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: SecCompanyFactsPeriod
}) {
  const anchor = findLatestSecStatementAnchor(
    params.data,
    [
      SEC_BALANCE_SHEET_CONCEPTS.totalAssets,
      SEC_BALANCE_SHEET_CONCEPTS.totalLiabilities,
      SEC_BALANCE_SHEET_CONCEPTS.stockholdersEquity,
    ],
    params.period
  )
  if (!anchor) {
    throw Object.assign(new Error("SEC balance sheet facts are unavailable."), {
      code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
      retryable: false,
    })
  }

  const cashAndEquivalents = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.cashAndEquivalents,
    params.period,
    anchor
  )
  const currentAssets = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentAssets,
    params.period,
    anchor
  )
  const totalAssets = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.totalAssets,
    params.period,
    anchor
  )
  const currentLiabilities = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentLiabilities,
    params.period,
    anchor
  )
  const totalLiabilities = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.totalLiabilities,
    params.period,
    anchor
  )
  const currentDebt = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.currentDebt,
    params.period,
    anchor
  )
  const longTermDebt = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.longTermDebt,
    params.period,
    anchor
  )
  const stockholdersEquity = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.stockholdersEquity,
    params.period,
    anchor
  )
  const liabilitiesAndEquity = findMatchingSecFact(
    params.data,
    SEC_BALANCE_SHEET_CONCEPTS.liabilitiesAndEquity,
    params.period,
    anchor
  )
  const totalDebt = sumDefinedValues([currentDebt?.value, longTermDebt?.value])

  return {
    statementType: "balance_sheet",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeSecCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: anchor.fiscalYear,
    fiscalPeriod: anchor.fiscalPeriod,
    form: anchor.form,
    filed: anchor.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodEnd: anchor.end,
    reportedFacts: {
      cashAndEquivalents: serializeSecFact(cashAndEquivalents),
      currentAssets: serializeSecFact(currentAssets),
      totalAssets: serializeSecFact(totalAssets),
      currentLiabilities: serializeSecFact(currentLiabilities),
      totalLiabilities: serializeSecFact(totalLiabilities),
      currentDebt: serializeSecFact(currentDebt),
      longTermDebt: serializeSecFact(longTermDebt),
      stockholdersEquity: serializeSecFact(stockholdersEquity),
      liabilitiesAndEquity: serializeSecFact(liabilitiesAndEquity),
    },
    computedValues: {
      totalDebt,
      netDebt:
        typeof totalDebt === "number" &&
        typeof cashAndEquivalents?.value === "number"
          ? totalDebt - cashAndEquivalents.value
          : undefined,
      workingCapital:
        typeof currentAssets?.value === "number" &&
        typeof currentLiabilities?.value === "number"
          ? currentAssets.value - currentLiabilities.value
          : undefined,
      liabilitiesToAssets: totalAssets
        ? calculateRatio(totalLiabilities?.value, totalAssets.value)
        : undefined,
      equityRatio: totalAssets
        ? calculateRatio(stockholdersEquity?.value, totalAssets.value)
        : undefined,
      debtToAssets:
        typeof totalDebt === "number" && totalAssets
          ? calculateRatio(totalDebt, totalAssets.value)
          : undefined,
    },
  }
}

function summarizeSecCashFlowStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  period: SecCompanyFactsPeriod
}) {
  const operatingCashFlow = findLatestSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.operatingCashFlow,
    params.period
  )
  if (!operatingCashFlow) {
    throw Object.assign(
      new Error("SEC cash flow statement facts are unavailable."),
      {
        code: "SEC_FINANCIAL_STATEMENTS_UNAVAILABLE",
        retryable: false,
      }
    )
  }

  const capitalExpenditures = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.capitalExpenditures,
    params.period,
    operatingCashFlow
  )
  const depreciationAndAmortization = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.depreciationAndAmortization,
    params.period,
    operatingCashFlow
  )
  const shareBasedCompensation = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.shareBasedCompensation,
    params.period,
    operatingCashFlow
  )
  const dividendsPaid = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.dividendsPaid,
    params.period,
    operatingCashFlow
  )
  const shareRepurchases = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.shareRepurchases,
    params.period,
    operatingCashFlow
  )
  const cashPeriodChange = findMatchingSecFact(
    params.data,
    SEC_CASH_FLOW_CONCEPTS.cashPeriodChange,
    params.period,
    operatingCashFlow
  )
  const revenue = findMatchingSecFact(
    params.data,
    SEC_INCOME_STATEMENT_CONCEPTS.revenue,
    params.period,
    operatingCashFlow
  )
  const capexValue = capitalExpenditures?.value
  const freeCashFlow =
    typeof capexValue === "number"
      ? operatingCashFlow.value - Math.abs(capexValue)
      : undefined

  return {
    statementType: "cash_flow",
    provider: "sec",
    source: "SEC company facts",
    cik: normalizeSecCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    fiscalYear: operatingCashFlow.fiscalYear,
    fiscalPeriod: operatingCashFlow.fiscalPeriod,
    form: operatingCashFlow.form,
    filed: operatingCashFlow.filed,
    ...(params.filing ? { filing: params.filing } : {}),
    periodStart: operatingCashFlow.start,
    periodEnd: operatingCashFlow.end,
    reportedFacts: {
      operatingCashFlow: serializeSecFact(operatingCashFlow),
      capitalExpenditures: serializeSecFact(capitalExpenditures),
      depreciationAndAmortization: serializeSecFact(
        depreciationAndAmortization
      ),
      shareBasedCompensation: serializeSecFact(shareBasedCompensation),
      dividendsPaid: serializeSecFact(dividendsPaid),
      shareRepurchases: serializeSecFact(shareRepurchases),
      cashPeriodChange: serializeSecFact(cashPeriodChange),
      revenue: serializeSecFact(revenue),
    },
    computedValues: {
      freeCashFlow,
      freeCashFlowMargin:
        typeof freeCashFlow === "number" && revenue
          ? calculateRatio(freeCashFlow, revenue.value)
          : undefined,
    },
  }
}

export function summarizeSecFinancialStatement(params: {
  data: unknown
  cik: string
  symbol?: string
  filing?: SecFilingSummary
  statementType?: SecFinancialStatementType
  period: SecCompanyFactsPeriod
}) {
  if (params.statementType === "balance_sheet") {
    return summarizeSecBalanceSheet(params)
  }

  if (params.statementType === "cash_flow") {
    return summarizeSecCashFlowStatement(params)
  }

  return summarizeSecIncomeStatement(params)
}

export function summarizeSecCompanyFacts(params: {
  data: unknown
  cik: string
  symbol?: string
}) {
  const record = asRecord(params.data)
  const facts = asRecord(record?.facts)
  const usGaap = asRecord(facts?.["us-gaap"])
  const selectedConcepts = SEC_FINANCIAL_STATEMENT_CONCEPTS.filter((concept) =>
    Boolean(usGaap?.[concept])
  )

  let latestAnnualIncomeStatement: unknown
  let latestAnnualBalanceSheet: unknown
  let latestAnnualCashFlowStatement: unknown
  try {
    latestAnnualIncomeStatement = summarizeSecIncomeStatement({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualIncomeStatement = undefined
  }
  try {
    latestAnnualBalanceSheet = summarizeSecBalanceSheet({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualBalanceSheet = undefined
  }
  try {
    latestAnnualCashFlowStatement = summarizeSecCashFlowStatement({
      data: params.data,
      cik: params.cik,
      symbol: params.symbol,
      period: "annual",
    })
  } catch {
    latestAnnualCashFlowStatement = undefined
  }

  return {
    cik: normalizeSecCik(params.cik),
    ...(params.symbol ? { symbol: normalizeTickerSymbol(params.symbol) } : {}),
    entityName: toOptionalString(record?.entityName),
    taxonomyNamespaces: Object.keys(facts ?? {}).sort(),
    usGaapConceptCount: Object.keys(usGaap ?? {}).length,
    selectedConcepts,
    ...(latestAnnualIncomeStatement ? { latestAnnualIncomeStatement } : {}),
    ...(latestAnnualBalanceSheet ? { latestAnnualBalanceSheet } : {}),
    ...(latestAnnualCashFlowStatement ? { latestAnnualCashFlowStatement } : {}),
  }
}
