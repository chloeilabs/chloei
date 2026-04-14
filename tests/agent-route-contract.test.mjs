import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const routePath = path.join(cwd, "src/app/api/agent/route.ts")

test("agent route request contract no longer accepts legacy connector config", async () => {
  const source = await readFile(routePath, "utf8")

  assert.match(
    source,
    /const agentStreamRequestSchema = z[\s\S]*model: z\.enum\(allowedModels\)\.optional\(\),[\s\S]*threadId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\),[\s\S]*messages: z\.array\(agentMessageSchema\)\.min\(1\)\.max\(AGENT_MAX_MESSAGES\),[\s\S]*\.strict\(\)/,
    "Expected /api/agent to validate model, threadId, and messages."
  )

  assert.doesNotMatch(
    source,
    /agentConfig/,
    "Expected /api/agent to drop legacy connector config."
  )
})

test("agent route still streams through the simplified OpenRouter path", async () => {
  const source = await readFile(routePath, "utf8")

  assert.match(
    source,
    /const stream = startOpenRouterResponseStream\(\{[\s\S]*messages: parsed\.data\.messages,[\s\S]*systemInstruction: withAiSdkInlineCitationInstruction\(/,
    "Expected /api/agent to stream via startOpenRouterResponseStream."
  )

  assert.doesNotMatch(
    source,
    /approvalGrant|userId:\s*session\.user\.id/,
    "Expected /api/agent to avoid the removed connector and approval flow."
  )

  assert.match(
    source,
    /withAiSdkInlineCitationInstruction\(\s*systemInstruction,\s*\{\s*fmpEnabled: Boolean\(fmpApiKey\?\.trim\(\)\),\s*\}\s*\)/,
    "Expected /api/agent to pass only the remaining augmentation options."
  )
})
