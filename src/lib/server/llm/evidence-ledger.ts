import type { MessageSource } from "@/lib/shared"

export type EvidenceConfidence = "high" | "medium" | "low"
export type EvidenceKind =
  | "calculation"
  | "filing"
  | "macro"
  | "market_data"
  | "news"
  | "reference"

export interface AgentEvidence {
  id: string
  kind: EvidenceKind
  provider: string
  operation: string
  title: string
  summary: string
  confidence: EvidenceConfidence
  retrievedAt: string
  source?: MessageSource
  dataVintage?: string
  reportedValues?: Record<string, unknown>
  computedValues?: Record<string, unknown>
  limitations?: string[]
}

export interface EvidenceVerification {
  status: "verified" | "partial" | "insufficient"
  checks: string[]
  gaps: string[]
  conflicts: string[]
}

export interface InvestmentMemoVerificationInput {
  hasPrimarySourceCapexRebuild?: boolean
  hasDcfSensitivityMatrix?: boolean
  hasCodeVerifiedDcfMath?: boolean
  hasProbabilityWeightedExpectedValue?: boolean
  hasChinaExportSizing?: boolean
  labelsEstimatedCustomerExposure?: boolean
  softensUnverifiedAiChipClaims?: boolean
  rejectsUnsupportedSecondaryCatalysts?: boolean
}

export interface EvidenceLedger {
  evidence: AgentEvidence[]
  sources: MessageSource[]
  verification: EvidenceVerification
}

interface AddEvidenceInput {
  kind: EvidenceKind
  provider: string
  operation: string
  title: string
  summary: string
  confidence?: EvidenceConfidence
  retrievedAt?: Date
  source?: MessageSource
  dataVintage?: string
  reportedValues?: Record<string, unknown>
  computedValues?: Record<string, unknown>
  limitations?: string[]
}

function getEvidenceId(input: AddEvidenceInput, index: number): string {
  return [
    "evidence",
    input.provider
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
    input.operation
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
    String(index + 1),
  ].join("-")
}

function upsertSource(
  sources: MessageSource[],
  source: MessageSource | undefined
): MessageSource[] {
  if (!source?.url.trim()) {
    return sources
  }

  return sources.some((candidate) => candidate.url === source.url)
    ? sources
    : [...sources, source]
}

export function createEvidenceLedger(): EvidenceLedger {
  return {
    evidence: [],
    sources: [],
    verification: {
      status: "insufficient",
      checks: [],
      gaps: ["No evidence has been collected yet."],
      conflicts: [],
    },
  }
}

export function addEvidence(
  ledger: EvidenceLedger,
  input: AddEvidenceInput
): EvidenceLedger {
  const nextEvidence: AgentEvidence = {
    id: getEvidenceId(input, ledger.evidence.length),
    kind: input.kind,
    provider: input.provider,
    operation: input.operation,
    title: input.title,
    summary: input.summary,
    confidence: input.confidence ?? "medium",
    retrievedAt: (input.retrievedAt ?? new Date()).toISOString(),
    ...(input.source ? { source: input.source } : {}),
    ...(input.dataVintage ? { dataVintage: input.dataVintage } : {}),
    ...(input.reportedValues ? { reportedValues: input.reportedValues } : {}),
    ...(input.computedValues ? { computedValues: input.computedValues } : {}),
    ...(input.limitations?.length ? { limitations: input.limitations } : {}),
  }

  const evidence = [...ledger.evidence, nextEvidence]
  return {
    evidence,
    sources: upsertSource(ledger.sources, input.source),
    verification: verifyEvidence(evidence),
  }
}

export function verifyEvidence(
  evidence: readonly AgentEvidence[]
): EvidenceVerification {
  if (evidence.length === 0) {
    return {
      status: "insufficient",
      checks: [],
      gaps: ["No evidence has been collected yet."],
      conflicts: [],
    }
  }

  const checks = evidence.map(
    (entry) => `${entry.provider}:${entry.operation}:${entry.confidence}`
  )
  const gaps = evidence.flatMap((entry) => entry.limitations ?? [])
  const providersByKind = new Map<EvidenceKind, Set<string>>()

  for (const entry of evidence) {
    const providers = providersByKind.get(entry.kind) ?? new Set<string>()
    providers.add(entry.provider)
    providersByKind.set(entry.kind, providers)
  }

  const sourceBackedEvidence = evidence.filter((entry) => entry.source)
  const sourceGap =
    sourceBackedEvidence.length === 0
      ? ["No source-backed evidence is available for citation."]
      : []

  return {
    status: [...gaps, ...sourceGap].length > 0 ? "partial" : "verified",
    checks,
    gaps: [...gaps, ...sourceGap],
    conflicts: [],
  }
}

export function verifyInvestmentMemoRequirements(
  input: InvestmentMemoVerificationInput
): EvidenceVerification {
  const checks: string[] = []
  const gaps: string[] = []

  const requireCheck = (
    satisfied: boolean | undefined,
    check: string,
    gap: string
  ) => {
    if (satisfied) {
      checks.push(check)
      return
    }

    gaps.push(gap)
  }

  requireCheck(
    input.hasPrimarySourceCapexRebuild,
    "Primary-source hyperscaler capex rebuild present.",
    "Rebuild hyperscaler capex from AMZN/MSFT/GOOGL/META filings or calls before relying on aggregate capex claims."
  )
  requireCheck(
    input.hasDcfSensitivityMatrix,
    "DCF sensitivity matrix present.",
    "Add a DCF sensitivity matrix for WACC, FCF margin, terminal value assumptions, and share count."
  )
  requireCheck(
    input.hasCodeVerifiedDcfMath,
    "DCF math is code-verified.",
    "Verify DCF and scenario math with code execution or explicitly label it as manually computed/unverified."
  )
  requireCheck(
    input.hasProbabilityWeightedExpectedValue,
    "Probability-weighted expected value computed.",
    "Compute probability-weighted expected value when scenario probabilities and prices are provided."
  )
  requireCheck(
    input.hasChinaExportSizing,
    "China/export-control risk sized.",
    "Size China/export-control exposure, product restrictions, guidance impact, and margin/revenue tradeoffs."
  )
  requireCheck(
    input.labelsEstimatedCustomerExposure,
    "Estimated customer exposure is labeled.",
    "Label hyperscaler/customer exposure estimates unless directly disclosed by the company."
  )
  requireCheck(
    input.rejectsUnsupportedSecondaryCatalysts,
    "Unsupported secondary-source catalysts rejected or downgraded.",
    "Downgrade or remove catalyst claims when secondary sources do not support the exact claim."
  )
  requireCheck(
    input.softensUnverifiedAiChipClaims,
    "Unverified AI-chip substitution/training claims are softened.",
    "Avoid over-specific claims such as named model training on Trainium unless supported by primary sources; frame them as infrastructure commitments or substitution risk when that is all the source supports."
  )

  return {
    status: gaps.length > 0 ? "partial" : "verified",
    checks,
    gaps,
    conflicts: [],
  }
}
