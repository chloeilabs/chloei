import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routePath = path.join(cwd, "src/app/api/agent/route.ts")
const helperPath = path.join(cwd, "src/lib/server/agent-route.ts")
const runtimePath = path.join(cwd, "src/lib/server/llm/agent-runtime.ts")
const synthesisGatingPath = path.join(
  cwd,
  "src/lib/server/llm/agent-runtime-synthesis-gating.ts"
)

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
    /systemInstruction: withAiSdkInlineCitationInstruction\(\s*params\.systemInstruction\s*\)/,
    "Expected the helper to augment the system instruction with inline-citation rules only."
  )

  assert.doesNotMatch(
    helperSource,
    /shouldIncludeFinanceToolingInstruction|shouldIncludeSecFilingsToolingInstruction|financeEnabled|secFilingsEnabled/,
    "Expected the helper to drop the removed finance tooling augmentation options."
  )

  assert.match(
    routeSource,
    /runtimeProfile: resolveRuntimeProfile\(\s*parsedRequest\.runMode\s*\)/,
    "Expected /api/agent to select a runtime profile from the requested run mode."
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
  const synthesisGatingSource = await readFile(synthesisGatingPath, "utf8")

  assert.match(
    runtimeSource,
    /FINAL_SYNTHESIS_STEP_INSTRUCTION/,
    "Expected a dedicated final synthesis instruction."
  )
  assert.match(
    runtimeSource,
    /prepareStep:\s*\(\{[\s\S]*stepNumber[\s\S]*\}\)[\s\S]*shouldForceFinalSynthesisStep\(\s*stepNumber,\s*runtimeProfile\.toolMaxSteps\s*\)[\s\S]*toolChoice:\s*"none"/,
    "Expected the last permitted model step to disable tools."
  )
  assert.match(
    synthesisGatingSource,
    /stepNumber\s*>=\s*Math\.max\(0,\s*toolMaxSteps\s*-\s*1\)/,
    "Expected final synthesis to happen before the profile step budget stops the loop."
  )
})

test("agent runtime extends the AI Gateway client timeout", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")
  const gatewayClientPath = path.join(
    cwd,
    "src/lib/server/llm/gateway-client.ts"
  )
  const gatewayClientSource = await readFile(gatewayClientPath, "utf8")

  assert.match(
    gatewayClientSource,
    /new Dispatcher1Wrapper\(\s*new Agent\(\{\s*bodyTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,\s*headersTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,\s*\}\)\s*\)/,
    "Expected the gateway client to use a custom Undici timeout dispatcher."
  )
  assert.match(
    runtimeSource,
    /createGateway\(\{\s*apiKey: params\.aiGatewayApiKey,\s*fetch: aiGatewayFetch,/,
    "Expected createGateway to receive the custom fetch implementation."
  )
})

test("agent runtime gives supported chat models the same runtime toolset", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")
  const helperSource = await readFile(helperPath, "utf8")

  assert.doesNotMatch(
    runtimeSource,
    /shouldEnableAmbientFinanceTools|shouldEnableCodeExecutionTools|shouldEnableModelToolCalling|shouldPrefetchWebEvidence|shouldPrefetchFinanceEvidence/,
    "Expected supported chat models to avoid model-specific tool suppression or prefetch branches."
  )
  assert.doesNotMatch(
    runtimeSource,
    /createAiSdkFinanceDataTools|createAiSdkSecFilingsTools|financeDataEnabled|secFilingsEnabled|codeExecutionBackend/,
    "Expected the removed finance and SEC runtime tooling to be gone for all models."
  )
  assert.match(
    runtimeSource,
    /createAiSdkCodeExecutionTools\(\{/,
    "Expected code execution tools to be created for all chat models."
  )
  assert.match(
    runtimeSource,
    /createAiSdkTavilyTools\(normalizedTavilyApiKey\)/,
    "Expected Tavily tools to be created for all chat models."
  )
  assert.doesNotMatch(
    helperSource,
    /shouldIncludeFinanceToolingInstruction|shouldIncludeSecFilingsToolingInstruction/,
    "Expected removed finance tooling-instruction helpers to be gone from the route helper."
  )
  assert.doesNotMatch(
    runtimeSource,
    /resolveMaxOutputTokens|maxOutputTokens/,
    "Expected chat requests to share the uncapped output budget used by supported models."
  )
})

test("agent runtime does not include removed model step compatibility hooks", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.doesNotMatch(
    runtimeSource,
    /getCompatibleStepMessages|compatibleMessages/,
    "Expected the runtime to avoid removed model step compatibility code."
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
