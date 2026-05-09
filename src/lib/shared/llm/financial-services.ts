export const FINANCIAL_SERVICES_WORKFLOWS = [
  "financial_modeling",
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
  "market-researcher",
  "pitch-materials",
] as const

export type FinancialServicesSkillId =
  (typeof FINANCIAL_SERVICES_SKILL_IDS)[number]
