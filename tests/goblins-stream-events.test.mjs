import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/agent-stream-events.ts")
).href

const { parseStreamEventLine } = await import(moduleUrl)

test("parseStreamEventLine parses subagent_call with task + checkpoint fields", () => {
  const line = JSON.stringify({
    type: "subagent_call",
    callId: "call-1",
    subagentId: "goblin_web_researcher",
    label: "Web Researcher",
    task: "  find recent sources  ",
    interactionId: "interaction-1",
    lastEventId: "event-1",
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "subagent_call",
    callId: "call-1",
    subagentId: "goblin_web_researcher",
    label: "Web Researcher",
    task: "find recent sources",
    interactionId: "interaction-1",
    lastEventId: "event-1",
  })
})

test("parseStreamEventLine parses subagent_result", () => {
  const line = JSON.stringify({
    type: "subagent_result",
    callId: "call-1",
    subagentId: "goblin_contrarian",
    status: "success",
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "subagent_result",
    callId: "call-1",
    subagentId: "goblin_contrarian",
    status: "success",
  })
})

test("parseStreamEventLine rejects subagent events with an unknown subagentId", () => {
  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "subagent_call",
        callId: "call-1",
        subagentId: "not-a-goblin",
        label: "Nope",
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "subagent_result",
        callId: "call-1",
        subagentId: "not-a-goblin",
        status: "success",
      })
    ),
    null
  )
})

test("parseStreamEventLine rejects subagent_call missing a label and bad result status", () => {
  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "subagent_call",
        callId: "call-1",
        subagentId: "goblin_web_researcher",
        label: "   ",
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "subagent_result",
        callId: "call-1",
        subagentId: "goblin_web_researcher",
        status: "running",
      })
    ),
    null
  )
})
