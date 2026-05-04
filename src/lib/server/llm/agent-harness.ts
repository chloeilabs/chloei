import type { PromptTaskMode } from "@/lib/server/agent-prompt-steering"
import {
  AGENT_RESEARCH_TOOL_MAX_STEPS,
  AGENT_TOOL_MAX_STEPS,
} from "@/lib/server/agent-runtime-config"
import type { ModelType } from "@/lib/shared"

import type { CodeExecutionBackend } from "./code-execution-tools"

export type AgentHarnessDomain =
  | "general"
  | "research"
  | "finance"
  | "math_data"
  | "coding"
  | "high_stakes"
  | "closed_answer"
  | "instruction_following"

export type AgentHarnessExecutionMode = "tool_loop" | "durable_workflow_ready"

export type AgentRuntimeProfileId =
  | "chat_default"
  | "deep_research"
  | "finance_analysis"
  | "math_data"
  | "gdpval_workspace"

export interface AgentHarnessProfile {
  id: AgentRuntimeProfileId
  domain: AgentHarnessDomain
  codeExecutionBackend?: CodeExecutionBackend
  codeExecutionWorkspaceMode?: "ephemeral" | "preserve"
  fmpMcpEnabled: boolean
  financeDataEnabled: boolean
  toolMaxSteps: number
}

export interface AgentHarnessConfig {
  domain: AgentHarnessDomain
  executionMode: AgentHarnessExecutionMode
  runtimeProfile: AgentRuntimeProfileId
  codeExecutionRequired: boolean
  structuredFinanceRequired: boolean
  webEvidenceRequired: boolean
  approvalGatesSupported: boolean
  observabilityLabel: string
}

export interface ResolveAgentHarnessConfigParams {
  taskMode: PromptTaskMode
  runMode: "chat" | "research"
  model: ModelType
}

export const AGENT_HARNESS_PROFILES: Record<
  AgentRuntimeProfileId,
  AgentHarnessProfile
> = {
  chat_default: {
    id: "chat_default",
    domain: "general",
    fmpMcpEnabled: true,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  deep_research: {
    id: "deep_research",
    domain: "research",
    fmpMcpEnabled: true,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_RESEARCH_TOOL_MAX_STEPS,
  },
  finance_analysis: {
    id: "finance_analysis",
    domain: "finance",
    codeExecutionBackend: "finance",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  math_data: {
    id: "math_data",
    domain: "math_data",
    codeExecutionBackend: "finance",
    fmpMcpEnabled: false,
    financeDataEnabled: false,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
  gdpval_workspace: {
    id: "gdpval_workspace",
    domain: "finance",
    codeExecutionBackend: "finance",
    codeExecutionWorkspaceMode: "preserve",
    fmpMcpEnabled: false,
    financeDataEnabled: true,
    toolMaxSteps: AGENT_TOOL_MAX_STEPS,
  },
}

function resolveHarnessDomain(
  taskMode: PromptTaskMode,
  runMode: "chat" | "research"
): AgentHarnessDomain {
  if (runMode === "research") {
    return "research"
  }

  switch (taskMode) {
    case "finance_analysis":
      return "finance"
    case "math_data":
      return "math_data"
    case "coding":
      return "coding"
    case "research":
      return "research"
    case "high_stakes":
      return "high_stakes"
    case "closed_answer":
      return "closed_answer"
    case "instruction_following":
      return "instruction_following"
    case "general":
      return "general"
  }
}

function resolveHarnessRuntimeProfile(
  domain: AgentHarnessDomain,
  runMode: "chat" | "research"
): AgentRuntimeProfileId {
  if (runMode === "research" || domain === "research") {
    return "deep_research"
  }

  if (domain === "finance") {
    return "finance_analysis"
  }

  if (domain === "math_data") {
    return "math_data"
  }

  return "chat_default"
}

function resolveHarnessExecutionMode(
  domain: AgentHarnessDomain,
  runMode: "chat" | "research"
): AgentHarnessExecutionMode {
  return runMode === "research" ||
    domain === "research" ||
    domain === "finance" ||
    domain === "math_data"
    ? "durable_workflow_ready"
    : "tool_loop"
}

export function resolveAgentHarnessProfile(
  id: AgentRuntimeProfileId | undefined
): AgentHarnessProfile {
  return AGENT_HARNESS_PROFILES[id ?? "chat_default"]
}

export function resolveAgentHarnessConfig(
  params: ResolveAgentHarnessConfigParams
): AgentHarnessConfig {
  void params.model
  const domain = resolveHarnessDomain(params.taskMode, params.runMode)

  return {
    domain,
    executionMode: resolveHarnessExecutionMode(domain, params.runMode),
    runtimeProfile: resolveHarnessRuntimeProfile(domain, params.runMode),
    codeExecutionRequired:
      domain === "math_data" || domain === "finance" || domain === "coding",
    structuredFinanceRequired: domain === "finance",
    webEvidenceRequired: domain === "research",
    approvalGatesSupported:
      domain === "finance" ||
      domain === "research" ||
      domain === "math_data" ||
      domain === "coding",
    observabilityLabel: `chloei.${domain}`,
  }
}

export function shouldUsePrefetchedEvidenceForModel(
  model: ModelType,
  profile: AgentHarnessProfile
): boolean {
  return (
    model.startsWith("xai/") &&
    (profile.id === "chat_default" || profile.id === "finance_analysis")
  )
}

export function shouldEnableAmbientFinanceTools(
  model: ModelType,
  profile: AgentHarnessProfile
): boolean {
  return (
    profile.financeDataEnabled &&
    !shouldUsePrefetchedEvidenceForModel(model, profile)
  )
}

export function shouldEnableCodeExecutionTools(
  model: ModelType,
  profile: AgentHarnessProfile
): boolean {
  if (profile.domain === "math_data") {
    return true
  }

  return !shouldUsePrefetchedEvidenceForModel(model, profile)
}

export function shouldEnableModelToolCalling(
  model: ModelType,
  profile: AgentHarnessProfile
): boolean {
  return !shouldUsePrefetchedEvidenceForModel(model, profile)
}

export function createAgentHarnessId(profile: AgentHarnessProfile): string {
  return `chloei-${profile.domain}-${profile.id}`
}
