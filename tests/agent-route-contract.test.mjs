import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routePath = path.join(cwd, "src/app/api/agent/route.ts")
const helperPath = path.join(cwd, "src/lib/server/agent-route.ts")
const runtimePath = path.join(cwd, "src/lib/server/llm/agent-runtime.ts")

test("agent route validates model, threadId, and messages", async () => {
  const source = await readFile(helperPath, "utf8")

  assert.match(
    source,
    /const agentStreamRequestSchema = z[\s\S]*model: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\),[\s\S]*threadId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\),[\s\S]*messages: z\.array\(agentMessageSchema\)\.min\(1\),[\s\S]*\.strict\(\)/,
    "Expected /api/agent to validate model, threadId, and messages."
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

test("agent route streams through the extracted helper path", async () => {
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

  assert.doesNotMatch(
    routeSource,
    /runMode|resolveRuntimeProfile/,
    "Expected /api/agent to drop run-mode and runtime-profile selection."
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

test("agent runtime runs a forced final synthesis when no text was emitted", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.match(
    runtimeSource,
    /FINAL_SYNTHESIS_STEP_INSTRUCTION/,
    "Expected a dedicated final synthesis instruction."
  )
  assert.match(
    runtimeSource,
    /maxTurns:[^,\n]*AGENT_TOOL_MAX_STEPS/,
    "Expected the run to cap tool turns with maxTurns (default AGENT_TOOL_MAX_STEPS)."
  )
  assert.match(
    runtimeSource,
    /if \(!hasEmittedText && !params\.signal\?\.aborted\)[\s\S]*run\(synthesisAgent/,
    "Expected a second synthesis run when the main run emitted no text."
  )
  assert.match(
    runtimeSource,
    /MaxTurnsExceededError/,
    "Expected MaxTurnsExceeded to be caught and routed to final synthesis."
  )
})

test("agent runtime configures the OpenAI Agents SDK client", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")
  const clientPath = path.join(cwd, "src/lib/server/llm/openai-client.ts")
  const clientSource = await readFile(clientPath, "utf8")

  assert.match(
    clientSource,
    /setDefaultOpenAIKey\(apiKey\)/,
    "Expected the client module to set the default OpenAI API key."
  )
  assert.match(
    clientSource,
    /getGlobalTraceProvider\(\)\.setDisabled\(true\)/,
    "Expected agent tracing to be disabled."
  )
  assert.match(
    runtimeSource,
    /configureOpenAiForAgents\(params\.openAiApiKey\)/,
    "Expected the runtime to configure the OpenAI client from the threaded key."
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
    /createOpenAiAgentsExaTools\(/,
    "Expected Exa tools to be created for all chat models."
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

test("agent runtime logs when the model stream finishes", async () => {
  const runtimeSource = await readFile(runtimePath, "utf8")

  assert.match(
    runtimeSource,
    /await result\.completed/,
    "Expected the runtime to await stream completion."
  )
  assert.match(
    runtimeSource,
    /logger\.info\(\s*"Agent runtime stream finished\./,
    "Expected the runtime to log when the model stream finishes."
  )
})
