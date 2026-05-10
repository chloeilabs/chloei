export const FINANCIAL_SERVICES_WORKFLOWS = [
  "financial_modeling",
  "filing_research",
  "earnings_review",
  "market_research",
  "pitch_materials",
] as const

export type FinancialServicesWorkflowId =
  (typeof FINANCIAL_SERVICES_WORKFLOWS)[number]

export const FINANCIAL_SERVICES_SKILL_IDS = [
  "model-builder",
  "dcf-model",
  "comps-analysis",
  "audit-xls",
  "xlsx-author",
  "filing-researcher",
  "earnings-reviewer",
  "evidence-auditor",
  "sec-table-extractor",
  "market-researcher",
  "pitch-materials",
] as const

export type FinancialServicesSkillId =
  (typeof FINANCIAL_SERVICES_SKILL_IDS)[number]
