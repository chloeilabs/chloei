import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const harnessUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-harness.ts")
).href

const {
  createAgentHarnessId,
  resolveAgentHarnessConfig,
  resolveAgentHarnessProfile,
  shouldEnableAmbientFinanceTools,
  shouldEnableCodeExecutionTools,
  shouldEnableModelToolCalling,
} = await import(harnessUrl)

test("agent harness routes finance and math to specialist profiles", () => {
  const financeConfig = resolveAgentHarnessConfig({
    taskMode: "finance_analysis",
    runMode: "chat",
    model: "openai/gpt-5.5",
  })

  assert.equal(financeConfig.domain, "finance")
  assert.equal(financeConfig.runtimeProfile, "finance_analysis")
  assert.equal(financeConfig.structuredFinanceRequired, true)
  assert.equal(financeConfig.codeExecutionRequired, true)
  assert.equal(financeConfig.executionMode, "durable_workflow_ready")

  const mathConfig = resolveAgentHarnessConfig({
    taskMode: "math_data",
    runMode: "chat",
    model: "openai/gpt-5.5",
  })

  assert.equal(mathConfig.domain, "math_data")
  assert.equal(mathConfig.runtimeProfile, "math_data")
  assert.equal(mathConfig.structuredFinanceRequired, false)
  assert.equal(mathConfig.codeExecutionRequired, true)
})

test("agent harness routes explicit research mode to durable research policy", () => {
  const config = resolveAgentHarnessConfig({
    taskMode: "general",
    runMode: "research",
    model: "openai/gpt-5.5",
  })

  assert.equal(config.domain, "research")
  assert.equal(config.runtimeProfile, "deep_research")
  assert.equal(config.webEvidenceRequired, true)
  assert.equal(config.approvalGatesSupported, true)
  assert.equal(config.observabilityLabel, "chloei.research")
})

test("agent harness keeps Grok chat and finance tool loops focused", () => {
  const chatProfile = resolveAgentHarnessProfile("chat_default")
  const financeProfile = resolveAgentHarnessProfile("finance_analysis")
  const mathProfile = resolveAgentHarnessProfile("math_data")

  assert.equal(
    shouldEnableModelToolCalling("xai/grok-4.3", chatProfile),
    false
  )
  assert.equal(
    shouldEnableAmbientFinanceTools("xai/grok-4.3", financeProfile),
    false
  )
  assert.equal(
    shouldEnableCodeExecutionTools("xai/grok-4.3", financeProfile),
    false
  )
  assert.equal(
    shouldEnableCodeExecutionTools("xai/grok-4.3", mathProfile),
    true
  )
})

test("agent harness exposes stable agent ids", () => {
  assert.equal(
    createAgentHarnessId(resolveAgentHarnessProfile("deep_research")),
    "chloei-research-deep_research"
  )
})
