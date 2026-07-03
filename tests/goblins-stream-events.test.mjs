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

test("parseStreamEventLine parses goblins_phase with tier and round", () => {
  assert.deepEqual(
    parseStreamEventLine(
      JSON.stringify({
        type: "goblins_phase",
        phase: "triage",
        tier: "deep",
        label: "Sizing up the question",
      })
    ),
    {
      type: "goblins_phase",
      phase: "triage",
      tier: "deep",
      label: "Sizing up the question",
    }
  )

  assert.deepEqual(
    parseStreamEventLine(
      JSON.stringify({
        type: "goblins_phase",
        phase: "round",
        round: 2,
        label: "Research round 2 — filling gaps",
      })
    ),
    {
      type: "goblins_phase",
      phase: "round",
      round: 2,
      label: "Research round 2 — filling gaps",
    }
  )
})

test("parseStreamEventLine rejects malformed goblins_phase events", () => {
  assert.equal(
    parseStreamEventLine(
      JSON.stringify({ type: "goblins_phase", phase: "party", label: "x" })
    ),
    null
  )
  assert.equal(
    parseStreamEventLine(
      JSON.stringify({ type: "goblins_phase", phase: "round", label: "  " })
    ),
    null
  )
})

test("parseStreamEventLine keeps errorCode on subagent_result", () => {
  assert.deepEqual(
    parseStreamEventLine(
      JSON.stringify({
        type: "subagent_result",
        callId: "call-9",
        subagentId: "goblin_source_verifier",
        status: "error",
        errorCode: "GOBLIN_FAILED",
      })
    ),
    {
      type: "subagent_result",
      callId: "call-9",
      subagentId: "goblin_source_verifier",
      status: "error",
      errorCode: "GOBLIN_FAILED",
    }
  )
})
