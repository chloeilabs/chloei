import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routePath = path.join(cwd, "src/app/api/agent/route.ts")
const helperPath = path.join(cwd, "src/lib/server/agent-route.ts")
const runtimePath = path.join(cwd, "src/lib/server/llm/agent-runtime.ts")
const harnessPath = path.join(cwd, "src/lib/server/llm/agent-harness.ts")

test("agent route validates model, threadId, and messages", async () => {
  const source = await readFile(helperPath, "utf8")

  assert.match(
    source,
    /const agentStreamRequestSchema = z[\s\S]*model: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\),[\s\S]*runMode: z\.enum\(AGENT_RUN_MODES\)\.optional\(\),[\s\S]*threadId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\),[\s\S]*messages: z\.array\(agentMessageSchema\)\.min\(1\),[\s\S]*\.strict\(\)/,
    "Expected /api/agent to validate model, runMode, threadId, and messages."
  )

  assert.match(
    source,
    /parsed\.data\.messages\.length > AGENT_MAX_MESSAGES/,
    "Expected /api/agent to report oversized message histories after shape validation."
  )

  assert.doesNotMatch(
    source,
    /agentConfig/,
    "Expected the request contract to avoid removed connector config fields."
  )
})

test("agent route streams through the extracted AI Gateway helper path", async () => {
  const helperSource = await readFile(helperPath, "utf8")
  const routeSource = await readFile(routePath, "utf8")

  assert.match(
    routeSource,
    /from "@\/lib\/server\/agent-route"/,
    "Expected /api/agent to delegate request helpers to the server helper module."
  )

  assert.doesNotMatch(
    helperSource,
    /approvalGrant|userId:\s*session\.user\.id/,
    "Expected the helper to avoid removed connector and approval flow state."
  )

  assert.match(
    helperSource,
    /const stream = startGatewayResponseStream\(\{[\s\S]*requestId: params\.requestId,[\s\S]*messages: params\.messages,[\s\S]*systemInstruction: withAiSdkInlineCitationInstruction\(/,
    "Expected the helper to stream via startGatewayResponseStream."
  )

  assert.match(
    helperSource,
    /withAiSdkInlineCitationInstruction\(\s*params\.systemInstruction,\s*\{[\s\S]*financeEnabled: shouldIncludeFinanceToolingInstruction\([\s\S]*fmpEnabled: Boolean\(params\.fmpApiKey\?\.trim\(\)\),[\s\S]*\}\s*\)/,
    "Expected the helper to pass model-aware augmentation options."
  )

  assert.match(
    routeSource,
    /const harnessConfig = resolveAgentHarnessConfig\(\{[\s\S]*taskMode: promptTaskMode,[\s\S]*runMode: parsedRequest\.runMode,[\s\S]*model: selectedModel,[\s\S]*\}\)/,
    "Expected /api/agent to select an agent harness config from the inferred task mode and requested run mode."
  )
  assert.match(
    routeSource,
    /runtimeProfile: harnessConfig\.runtimeProfile/,
    "Expected /api/agent to pass the harness-selected runtime profile into the stream helper."
  )
})

test("agent route emits a visible fallback for tool-only completions", async () => {
  const helperSource = await readFile(helperPath, "utf8")

  assert.match(
    helperSource,
    /STRUCTURED_OUTPUT_ONLY_FALLBACK_TEXT/,
    "Expected a dedicated fallback for streams that produce tools or sources but no final assistant text."
  )
  assert.match(
    helperSource,
    /completedWithoutAnswer[\s\S]*streamState\.hasStructuredOutput[\s\S]*"incomplete"/,
    "Expected structured-output-only streams to settle as incomplete instead of silently completed."
  )
})

test("agent runtime reserves the final loop step for synthesis", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.match(
    runtimeSource,
    /FINAL_SYNTHESIS_STEP_INSTRUCTION/,
    "Expected a dedicated final synthesis instruction."
  )
  assert.match(
    runtimeSource,
    /prepareStep:\s*\(\{\s*stepNumber\s*\}\)[\s\S]*shouldForceFinalSynthesisStep\(stepNumber,\s*runtimeProfile\.toolMaxSteps\)[\s\S]*toolChoice:\s*"none"/,
    "Expected the last permitted model step to disable tools."
  )
  assert.match(
    runtimeSource,
    /stepNumber\s*>=\s*Math\.max\(0,\s*toolMaxSteps\s*-\s*1\)/,
    "Expected final synthesis to happen before the profile step budget stops the loop."
  )
})

test("agent runtime uses the AI SDK ToolLoopAgent harness", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")
  const harnessSource = await readFile(harnessPath, "utf8")

  assert.match(
    runtimeSource,
    /new ToolLoopAgent\(\{[\s\S]*id: createAgentHarnessId\(runtimeProfile\),[\s\S]*instructions: systemInstruction,[\s\S]*stopWhen: stepCountIs\(runtimeProfile\.toolMaxSteps\),[\s\S]*\}\)/,
    "Expected the runtime to create a reusable AI SDK ToolLoopAgent for Chloei runs."
  )
  assert.match(
    harnessSource,
    /export type AgentHarnessDomain =[\s\S]*"finance"[\s\S]*"math_data"[\s\S]*"research"/,
    "Expected the harness to model domain-specific orchestration policy."
  )
})

test("agent runtime extends the AI Gateway client timeout", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.match(
    runtimeSource,
    /new Dispatcher1Wrapper\(\s*new Agent\(\{\s*bodyTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,\s*headersTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,\s*\}\)\s*\)/,
    "Expected the AI Gateway runtime to use a custom Undici timeout dispatcher."
  )
  assert.match(
    runtimeSource,
    /createGateway\(\{\s*apiKey: params\.aiGatewayApiKey,\s*fetch: aiGatewayFetch,/,
    "Expected createGateway to receive the custom fetch implementation."
  )
})

test("agent runtime keeps Grok chat toolsets focused", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")
  const harnessSource = await readFile(harnessPath, "utf8")

  assert.match(
    harnessSource,
    /function shouldUsePrefetchedEvidenceForModel[\s\S]*model\.startsWith\("xai\/"\)[\s\S]*profile\.id === "chat_default"[\s\S]*profile\.id === "finance_analysis"/,
    "Expected Grok chat and finance requests to avoid model-driven ambient finance tools."
  )
  assert.match(
    runtimeSource,
    /runtimeProfile\.fmpMcpEnabled && ambientFinanceToolsEnabled/,
    "Expected FMP MCP tools to respect the focused Grok chat toolset."
  )
  assert.match(
    runtimeSource,
    /runtimeProfile\.financeDataEnabled && ambientFinanceToolsEnabled/,
    "Expected finance data tools to respect the focused Grok chat toolset."
  )
  assert.match(
    harnessSource,
    /function shouldEnableCodeExecutionTools[\s\S]*profile\.domain === "math_data"[\s\S]*shouldUsePrefetchedEvidenceForModel\(model,\s*profile\)/,
    "Expected Grok chat and finance requests to avoid model-driven code execution loops."
  )
  assert.match(
    runtimeSource,
    /codeExecutionToolsEnabled[\s\S]*createAiSdkCodeExecutionTools/,
    "Expected code execution tools to respect the focused Grok chat toolset."
  )
  assert.match(
    harnessSource,
    /function shouldEnableModelToolCalling[\s\S]*shouldUsePrefetchedEvidenceForModel\(model,\s*profile\)/,
    "Expected Grok chat and finance requests to avoid model-initiated tool loops."
  )
  assert.match(
    runtimeSource,
    /createAiSdkTavilyEvidenceContext/,
    "Expected Grok chat requests to prefetch Tavily evidence outside the model tool loop."
  )
  assert.match(
    runtimeSource,
    /createAiSdkFinanceDataEvidenceContext/,
    "Expected Grok finance requests to prefetch finance evidence outside the model tool loop."
  )
  assert.match(
    runtimeSource,
    /XAI_CHAT_MAX_OUTPUT_TOKENS\s*=\s*4096/,
    "Expected Grok chat requests to receive an explicit output budget."
  )
  assert.match(
    runtimeSource,
    /maxOutputTokens !== undefined \? \{ maxOutputTokens \} : \{\}/,
    "Expected the runtime to pass explicit maxOutputTokens when configured."
  )
})

test("agent runtime logs finish metadata for model streams", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.match(
    runtimeSource,
    /part\.type === "finish-step"[\s\S]*finishReason: part\.finishReason/,
    "Expected runtime step finish reasons to be logged."
  )
  assert.match(
    runtimeSource,
    /part\.type === "finish"[\s\S]*totalUsage/,
    "Expected final stream finish usage to be logged."
  )
})
