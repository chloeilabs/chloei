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
