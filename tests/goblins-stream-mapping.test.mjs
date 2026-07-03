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
const sharedUrl = pathToFileURL(path.join(cwd, "src/lib/shared/index.ts")).href

const { createAgentStreamMapper } = await import(mappingUrl)
const { resolveGoblinSubagent, GOBLIN_DEFINITIONS, createGoblinTools } =
  await import(goblinsAgentsUrl)
const { SUBAGENT_IDS } = await import(sharedUrl)

const toolCalledItem = (callId, name, args) => ({
  rawItem: {
    callId,
    name,
    ...(args ? { arguments: JSON.stringify(args) } : {}),
  },
})
const toolOutputItem = (callId, name, output) => ({
  rawItem: { callId, name },
  ...(output !== undefined ? { output } : {}),
})

test("mapper maps assistant text deltas", () => {
  const mapper = createAgentStreamMapper()
  assert.deepEqual(
    mapper.mapRawModelEvent({ type: "output_text_delta", delta: "hi" }),
    [{ type: "text_delta", delta: "hi" }]
  )
})

test("mapper with a subagent resolver emits subagent_call (with task) and subagent_result", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  const callEvents = mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c1", "goblin_web_researcher", {
      input: "find recent sources",
    })
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

  mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c1", "goblin_contrarian")
  )
  const dupCall = mapper.mapRunItemEvent(
    "tool_called",
    toolCalledItem("c1", "goblin_contrarian")
  )
  assert.deepEqual(dupCall, [])

  mapper.mapRunItemEvent(
    "tool_output",
    toolOutputItem("c1", "goblin_contrarian", "x")
  )
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

test("hosted tool items map to tool_call + balancing tool_result", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  // A completed hosted web search arrives whole: call + result together.
  const completed = mapper.mapRunItemEvent("tool_called", {
    rawItem: {
      type: "hosted_tool_call",
      id: "ws-1",
      name: "web_search_call",
      status: "completed",
      arguments: JSON.stringify({ query: "latest GDP figures" }),
    },
  })
  assert.deepEqual(
    completed.map((event) => event.type),
    ["tool_call", "tool_result"]
  )
  assert.equal(completed[0].toolName, "web_search")
  assert.equal(completed[0].label, "Searching the web")
  assert.equal(completed[0].query, "latest GDP figures")
  assert.equal(completed[0].provider, "openai")
  assert.equal(completed[1].status, "success")
  assert.equal(completed[1].callId, "ws-1")

  // Repeats of the same item id emit nothing new.
  const repeat = mapper.mapRunItemEvent("tool_output", {
    rawItem: {
      type: "hosted_tool_call",
      id: "ws-1",
      name: "web_search_call",
      status: "completed",
    },
  })
  assert.deepEqual(repeat, [])
})

test("hosted tool items surface failures and other tool kinds", () => {
  const mapper = createAgentStreamMapper({
    resolveSubagent: resolveGoblinSubagent,
  })

  const inProgress = mapper.mapRunItemEvent("tool_called", {
    rawItem: {
      type: "hosted_tool_call",
      id: "ci-1",
      name: "code_interpreter_call",
      status: "in_progress",
    },
  })
  assert.deepEqual(
    inProgress.map((event) => event.type),
    ["tool_call"]
  )
  assert.equal(inProgress[0].toolName, "code_interpreter")
  assert.equal(inProgress[0].label, "Running calculations")

  const failed = mapper.mapRunItemEvent("tool_output", {
    rawItem: {
      type: "hosted_tool_call",
      id: "ci-1",
      name: "code_interpreter_call",
      status: "failed",
    },
  })
  assert.deepEqual(
    failed.map((event) => event.type),
    ["tool_result"]
  )
  assert.equal(failed[0].status, "error")
  assert.equal(failed[0].errorCode, "HOSTED_TOOL_FAILED")

  const fileSearch = mapper.mapRunItemEvent("tool_called", {
    rawItem: {
      type: "hosted_tool_call",
      id: "fs-1",
      name: "file_search_call",
      status: "completed",
    },
  })
  assert.equal(fileSearch[0].toolName, "file_search")
  assert.equal(fileSearch[0].label, "Searching your documents")

  const unknown = mapper.mapRunItemEvent("tool_called", {
    rawItem: {
      type: "hosted_tool_call",
      id: "x-1",
      name: "image_generation_call",
      status: "completed",
    },
  })
  assert.deepEqual(unknown, [])
})

test("hosted tools are assigned per role and only when enabled", () => {
  const baseParams = { openAiApiKey: "key", exaApiKey: "exa" }

  // Flag off (no hosted context): no hosted tools anywhere.
  for (const definition of GOBLIN_DEFINITIONS) {
    const hostedTools = definition.hostedTools?.({}) ?? []
    if (definition.subagentId === "goblin_context_scout") {
      // file_search-only roles produce nothing without vector stores.
      assert.deepEqual(hostedTools, [])
    }
  }
  assert.ok(createGoblinTools(baseParams).every((tool) => tool.execute))

  // With vector stores, roles get their assigned hosted tools.
  const context = { vectorStoreIds: ["vs_123"] }
  const byId = new Map(
    GOBLIN_DEFINITIONS.map((definition) => [
      definition.subagentId,
      (definition.hostedTools?.(context) ?? []).map((tool) => tool.name),
    ])
  )
  assert.deepEqual(byId.get("goblin_web_researcher"), ["web_search"])
  assert.deepEqual(byId.get("goblin_recency_scout"), ["web_search"])
  assert.deepEqual(byId.get("goblin_contrarian"), ["web_search"])
  assert.deepEqual(byId.get("goblin_source_verifier"), [
    "web_search",
    "file_search",
  ])
  assert.deepEqual(byId.get("goblin_numbers_analyst"), [
    "code_interpreter",
    "file_search",
  ])
  assert.deepEqual(byId.get("goblin_context_scout"), ["file_search"])

  // Without vector stores, file_search drops out but web tools remain.
  const noStores = new Map(
    GOBLIN_DEFINITIONS.map((definition) => [
      definition.subagentId,
      (definition.hostedTools?.({}) ?? []).map((tool) => tool.name),
    ])
  )
  assert.deepEqual(noStores.get("goblin_source_verifier"), ["web_search"])
  assert.deepEqual(noStores.get("goblin_numbers_analyst"), ["code_interpreter"])
})
