import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
  "./openai-agents-exa-tools": toProjectFileUrl(
    "tests/stubs/openai-agents-exa-tools.mjs"
  ),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
})

const { startGoblinsRuntimeStream } = await import(
  pathToFileURL(path.join(cwd, "src/lib/server/llm/goblins-runtime.ts")).href
)
const { makeStreamResult } = await import(
  pathToFileURL(path.join(cwd, "tests/stubs/openai-agents.mjs")).href
)

const baseParams = {
  requestId: "req-1",
  model: "goblins",
  openAiApiKey: "openai-key",
  exaApiKey: "exa-key",
  messages: [{ role: "user", content: "Research the topic." }],
  systemInstruction: "system-instruction",
}

async function collect(generator) {
  const events = []
  for await (const event of generator) {
    events.push(event)
  }
  return events
}

const goblinCalledItem = (callId, name, task) => ({
  type: "run_item_stream_event",
  name: "tool_called",
  item: {
    rawItem: { callId, name, arguments: JSON.stringify({ input: task }) },
  },
})
const goblinOutputItem = (callId, name, output) => ({
  type: "run_item_stream_event",
  name: "tool_output",
  item: { rawItem: { callId, name }, output },
})
const textDeltaEvent = (delta) => ({
  type: "raw_model_stream_event",
  data: { type: "output_text_delta", delta },
})

beforeEach(() => {
  resetTestMocks()
})

test("manager delegates to goblins then streams the final answer in order", async () => {
  setTestMocks({
    agents: {
      run: () =>
        makeStreamResult(
          [
            goblinCalledItem("g1", "goblin_web_researcher", "find sources"),
            goblinOutputItem("g1", "goblin_web_researcher", "a brief"),
            goblinCalledItem("g2", "goblin_numbers_analyst", "get the figures"),
            goblinOutputItem("g2", "goblin_numbers_analyst", "the numbers"),
            textDeltaEvent("Final synthesized answer."),
          ],
          []
        ),
    },
  })

  const events = await collect(startGoblinsRuntimeStream(baseParams))
  const types = events.map((event) => event.type)

  // Two goblins each surface a call then a result, followed by the manager's text.
  assert.deepEqual(types, [
    "subagent_call",
    "subagent_result",
    "subagent_call",
    "subagent_result",
    "text_delta",
  ])

  assert.deepEqual(events[0], {
    type: "subagent_call",
    callId: "g1",
    subagentId: "goblin_web_researcher",
    label: "Web Researcher",
    task: "find sources",
  })
  assert.equal(events.at(-1).delta, "Final synthesized answer.")
})

test("forced final-synthesis fires when the manager ends on a tool turn with no text", async () => {
  setTestMocks({
    agents: {
      run: (agent) => {
        if (agent.options.name === "goblins-manager") {
          // Manager delegates but never writes the answer itself.
          return makeStreamResult(
            [
              goblinCalledItem("g1", "goblin_contrarian", "stress test"),
              goblinOutputItem("g1", "goblin_contrarian", "counterpoints"),
            ],
            [{ role: "user", content: "Research the topic." }]
          )
        }
        // Synthesis pass (goblins-manager-synthesis) writes the answer.
        return makeStreamResult([textDeltaEvent("Recovered answer.")], [])
      },
    },
  })

  const events = await collect(startGoblinsRuntimeStream(baseParams))
  const types = events.map((event) => event.type)

  assert.deepEqual(types, ["subagent_call", "subagent_result", "text_delta"])
  assert.equal(events.at(-1).delta, "Recovered answer.")
})

const adaptiveParams = {
  ...baseParams,
  featureFlags: { goblinsAdaptive: true },
}

const triageResult = (tier, suggestedGoblins) => ({
  finalOutput: { tier, ...(suggestedGoblins ? { suggestedGoblins } : {}) },
  state: {
    usage: {
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [],
    },
  },
})

test("adaptive run emits triage + round markers and applies tier budgets", async () => {
  let managerOptions = null
  let managerRunOptions = null
  setTestMocks({
    agents: {
      run: (agent, _input, options) => {
        if (agent.options.name === "goblins-triage") {
          return triageResult("deep", ["goblin_web_researcher"])
        }
        managerOptions = agent.options
        managerRunOptions = options
        return makeStreamResult(
          [
            goblinCalledItem("g1", "goblin_web_researcher", "find sources"),
            goblinOutputItem("g1", "goblin_web_researcher", "a brief"),
            goblinCalledItem("g2", "goblin_contrarian", "stress test"),
            goblinOutputItem("g2", "goblin_contrarian", "counterpoints"),
            textDeltaEvent("Adaptive answer."),
          ],
          []
        )
      },
    },
  })

  const events = await collect(startGoblinsRuntimeStream(adaptiveParams))
  const types = events.map((event) => event.type)

  // Triage phase first, then a round marker before each delegation round (the
  // second goblin call follows a result, so it opens round 2).
  assert.deepEqual(types, [
    "goblins_phase",
    "goblins_phase",
    "subagent_call",
    "subagent_result",
    "goblins_phase",
    "subagent_call",
    "subagent_result",
    "text_delta",
  ])
  assert.deepEqual(events[0], {
    type: "goblins_phase",
    phase: "triage",
    tier: "deep",
    label: "Sizing up the question",
  })
  assert.deepEqual(events[1], {
    type: "goblins_phase",
    phase: "round",
    round: 1,
    label: "Research round 1",
  })
  assert.deepEqual(events[4], {
    type: "goblins_phase",
    phase: "round",
    round: 2,
    label: "Research round 2 — filling gaps",
  })

  // Deep tier budgets applied to the manager run.
  assert.equal(managerRunOptions.maxTurns, 14)
  // Deep tier attaches the coverage_check evaluator alongside the six goblins.
  const toolNames = managerOptions.tools.map((tool) => tool.name)
  assert.ok(toolNames.includes("coverage_check"))
  assert.equal(toolNames.length, 7)
  // Multi-round instruction + volatile budget line + suggestion.
  assert.match(managerOptions.instructions, /delegation ROUNDS/)
  assert.match(managerOptions.instructions, /coverage_check/)
  assert.match(
    managerOptions.instructions,
    /at most 3 delegation round\(s\), about 5 goblins per round/
  )
  assert.match(managerOptions.instructions, /goblin_web_researcher/)
})

test("adaptive parallel batch yields a single round marker", async () => {
  setTestMocks({
    agents: {
      run: (agent) => {
        if (agent.options.name === "goblins-triage") {
          return triageResult("quick")
        }
        return makeStreamResult(
          [
            goblinCalledItem("g1", "goblin_web_researcher", "find sources"),
            goblinCalledItem("g2", "goblin_recency_scout", "latest news"),
            goblinOutputItem("g1", "goblin_web_researcher", "brief one"),
            goblinOutputItem("g2", "goblin_recency_scout", "brief two"),
            textDeltaEvent("Answer."),
          ],
          []
        )
      },
    },
  })

  const events = await collect(startGoblinsRuntimeStream(adaptiveParams))
  const roundMarkers = events.filter(
    (event) => event.type === "goblins_phase" && event.phase === "round"
  )
  assert.equal(roundMarkers.length, 1)
  assert.equal(roundMarkers[0].round, 1)
})

test("quick tier omits the coverage_check evaluator", async () => {
  let managerOptions = null
  setTestMocks({
    agents: {
      run: (agent) => {
        if (agent.options.name === "goblins-triage") {
          return triageResult("quick")
        }
        managerOptions = agent.options
        return makeStreamResult([textDeltaEvent("Direct answer.")], [])
      },
    },
  })

  await collect(startGoblinsRuntimeStream(adaptiveParams))
  const toolNames = managerOptions.tools.map((tool) => tool.name)
  assert.ok(!toolNames.includes("coverage_check"))
  assert.equal(toolNames.length, 6)
})

test("a GOBLIN_ERROR brief surfaces as a failed subagent result", async () => {
  setTestMocks({
    agents: {
      run: (agent) => {
        if (agent.options.name === "goblins-triage") {
          return triageResult("standard")
        }
        return makeStreamResult(
          [
            goblinCalledItem("g1", "goblin_source_verifier", "verify claims"),
            goblinOutputItem(
              "g1",
              "goblin_source_verifier",
              "GOBLIN_ERROR: goblin_source_verifier failed (boom). No findings gathered."
            ),
            textDeltaEvent("Answer with a named gap."),
          ],
          []
        )
      },
    },
  })

  const events = await collect(startGoblinsRuntimeStream(adaptiveParams))
  const result = events.find((event) => event.type === "subagent_result")
  assert.equal(result.status, "error")
  assert.equal(result.errorCode, "GOBLIN_FAILED")
})

test("flag-off keeps the legacy single-round flow with no phase events", async () => {
  setTestMocks({
    agents: {
      run: (agent, _input, options) => {
        assert.notEqual(agent.options.name, "goblins-triage")
        assert.equal(options.maxTurns, 8)
        assert.doesNotMatch(agent.options.instructions, /delegation ROUNDS/)
        assert.match(agent.options.instructions, /ONE parallel batch/)
        return makeStreamResult([textDeltaEvent("Legacy answer.")], [])
      },
    },
  })

  const events = await collect(startGoblinsRuntimeStream(baseParams))
  assert.ok(events.every((event) => event.type !== "goblins_phase"))
})
