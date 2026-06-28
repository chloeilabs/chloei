import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

// The real @openai/agents and ./openai-agents-exa-tools pull in CJS transitive
// deps (debug, exa-js → cross-fetch) the test loader can't traverse. Stub them;
// the mapper logic under test does not depend on their internals.
setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
  "./openai-agents-exa-tools": toProjectFileUrl(
    "tests/stubs/openai-agents-exa-tools.mjs"
  ),
})

const cwd = fileURLToPath(new URL("..", import.meta.url))
const mappingUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-stream-mapping.ts")
).href
const goblinsAgentsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/goblins-agents.ts")
).href
const sharedUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/index.ts")
).href

const { createAgentStreamMapper } = await import(mappingUrl)
const { resolveGoblinSubagent, GOBLIN_DEFINITIONS, createGoblinTools } =
  await import(goblinsAgentsUrl)
const { SUBAGENT_IDS } = await import(sharedUrl)

const toolCalledItem = (callId, name, args) => ({
  rawItem: { callId, name, ...(args ? { arguments: JSON.stringify(args) } : {}) },
})
const toolOutputItem = (callId, name, output) => ({
  rawItem: { callId, name },
  ...(output !== undefined ? { output } : {}),
})

test("mapper maps assistant text deltas", () => {
  const mapper = createAgentStreamMapper()
  assert.deepEqual(mapper.mapRawModelEvent({ type: "output_text_delta", delta: "hi" }), [
    { type: "text_delta", delta: "hi" },
  ])
})

test("mapper with a subagent resolver emits subagent_call (with task) and subagent_result", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  const callEvents = mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c1", "goblin_web_researcher", { input: "find recent sources" })
  )
  assert.deepEqual(callEvents, [
    {
      type: "subagent_call",
      callId: "c1",
      subagentId: "goblin_web_researcher",
      label: "Web Researcher",
      task: "find recent sources",
    },
  ])

  const resultEvents = mapper.mapRunItemEvent(
    "tool_output",
    toolOutputItem("c1", "goblin_web_researcher", "brief text")
  )
  assert.deepEqual(resultEvents, [
    {
      type: "subagent_result",
      callId: "c1",
      subagentId: "goblin_web_researcher",
      status: "success",
    },
  ])
})

test("mapper dedupes repeated subagent call/result for the same callId", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  mapper.mapRunItemEvent("tool_called", toolCalledItem("c1", "goblin_contrarian"))
  const dupCall = mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c1", "goblin_contrarian")
  )
  assert.deepEqual(dupCall, [])

  mapper.mapRunItemEvent("tool_output", toolOutputItem("c1", "goblin_contrarian", "x"))
  const dupResult = mapper.mapRunItemEvent(
    "tool_output",
    toolOutputItem("c1", "goblin_contrarian", "x")
  )
  assert.deepEqual(dupResult, [])
})

test("mapper still emits exa tool_call alongside subagents (resolver returns null for exa)", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  const events = mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c2", "exa_search", { query: "openai agents sdk" })
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "tool_call")
  assert.equal(events[0].toolName, "exa_search")
  assert.equal(events[0].callId, "c2")
})

test("single-model mapper (no resolver) ignores goblin tool names", () => {
  const mapper = createAgentStreamMapper()
  assert.deepEqual(
    mapper.mapRunItemEvent(
      "tool_called",
      toolCalledItem("c3", "goblin_web_researcher", { input: "x" })
    ),
    []
  )
})

test("resolveGoblinSubagent resolves known ids and rejects unknown", () => {
  assert.deepEqual(resolveGoblinSubagent("goblin_numbers_analyst"), {
    subagentId: "goblin_numbers_analyst",
    label: "Numbers Analyst",
  })
  assert.equal(resolveGoblinSubagent("exa_search"), null)
  assert.equal(resolveGoblinSubagent("nope"), null)
})

test("there are exactly 6 goblins and their ids are valid SubagentIds", () => {
  assert.equal(GOBLIN_DEFINITIONS.length, 6)
  const validIds = new Set(SUBAGENT_IDS)
  for (const definition of GOBLIN_DEFINITIONS) {
    assert.ok(
      validIds.has(definition.subagentId),
      `Unexpected goblin id: ${definition.subagentId}`
    )
  }
})

test("createGoblinTools builds one tool per goblin", () => {
  const tools = createGoblinTools({ openAiApiKey: "k", exaApiKey: "exa-key" })
  assert.equal(tools.length, 6)
  const toolNames = new Set(tools.map((tool) => tool.name))
  for (const definition of GOBLIN_DEFINITIONS) {
    assert.ok(
      toolNames.has(definition.subagentId),
      `Missing tool for goblin: ${definition.subagentId}`
    )
  }
})
