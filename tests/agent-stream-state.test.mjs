import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/agent-stream-state.ts")
).href

const { applyAgentStreamEvent, createAgentStreamAccumulator } = await import(
  moduleUrl
)

function applyReasoningDeltas(deltas) {
  return deltas.reduce(
    (accumulator, delta) =>
      applyAgentStreamEvent(accumulator, {
        type: "reasoning_delta",
        delta,
      }),
    createAgentStreamAccumulator()
  )
}

test("reasoning timeline preserves provider chunk boundaries inside words", () => {
  const accumulator = applyReasoningDeltas([
    "Let me get current quotes/fin",
    "ancial data for SCH",
    "D, SP",
    "YM, and MS",
    "FT.",
  ])
  const expected =
    "Let me get current quotes/financial data for SCHD, SPYM, and MSFT."

  assert.equal(accumulator.reasoning, expected)
  assert.equal(accumulator.activityTimeline.length, 1)
  assert.equal(accumulator.activityTimeline[0]?.kind, "reasoning")
  assert.equal(accumulator.activityTimeline[0]?.text, expected)
})

test("reasoning timeline preserves explicit trailing spaces between chunks", () => {
  const accumulator = applyReasoningDeltas([
    "Let ",
    "me ",
    "check ",
    "the quote.",
  ])
  const expected = "Let me check the quote."

  assert.equal(accumulator.reasoning, expected)
  assert.equal(accumulator.activityTimeline[0]?.kind, "reasoning")
  assert.equal(accumulator.activityTimeline[0]?.text, expected)
})

test("reasoning timeline ignores whitespace-only initial chunks", () => {
  const accumulator = applyReasoningDeltas(["\n\n", "Checking ", "quotes."])
  const expected = "Checking quotes."

  assert.equal(accumulator.reasoning, "\n\nChecking quotes.")
  assert.equal(accumulator.activityTimeline.length, 1)
  assert.equal(accumulator.activityTimeline[0]?.kind, "reasoning")
  assert.equal(accumulator.activityTimeline[0]?.text, expected)
})

test("reasoning timeline sanitizes private prompt terminology", () => {
  const accumulator = applyReasoningDeltas([
    "Follow SOUL.md and the system prompt.",
  ])
  const expected =
    "Follow private identity guidance and the private instructions."

  assert.equal(accumulator.reasoning, expected)
  assert.equal(accumulator.activityTimeline[0]?.kind, "reasoning")
  assert.equal(accumulator.activityTimeline[0]?.text, expected)
})

test("goblins_phase events append phase timeline entries in order", () => {
  let accumulator = createAgentStreamAccumulator()
  accumulator = applyAgentStreamEvent(accumulator, {
    type: "goblins_phase",
    phase: "triage",
    tier: "deep",
    label: "Sizing up the question",
  })
  accumulator = applyAgentStreamEvent(accumulator, {
    type: "goblins_phase",
    phase: "round",
    round: 1,
    label: "Research round 1",
  })

  const phases = accumulator.activityTimeline.filter(
    (entry) => entry.kind === "phase"
  )
  assert.equal(phases.length, 2)
  assert.deepEqual(
    phases.map((entry) => [entry.phase, entry.label]),
    [
      ["triage", "Sizing up the question"],
      ["round", "Research round 1"],
    ]
  )
  assert.equal(phases[0].tier, "deep")
  assert.equal(phases[1].round, 1)
  assert.ok(phases[1].order > phases[0].order)
})

test("a failed subagent entry never flips back to success", () => {
  let accumulator = createAgentStreamAccumulator()
  accumulator = applyAgentStreamEvent(accumulator, {
    type: "subagent_call",
    callId: "g-err",
    subagentId: "goblin_source_verifier",
    label: "Source Verifier",
  })
  accumulator = applyAgentStreamEvent(accumulator, {
    type: "subagent_result",
    callId: "g-err",
    subagentId: "goblin_source_verifier",
    status: "error",
    errorCode: "GOBLIN_FAILED",
  })
  accumulator = applyAgentStreamEvent(accumulator, {
    type: "subagent_result",
    callId: "g-err",
    subagentId: "goblin_source_verifier",
    status: "success",
  })

  const entry = accumulator.activityTimeline.find(
    (candidate) => candidate.kind === "subagent"
  )
  assert.equal(entry.status, "error")
  assert.equal(entry.errorCode, "GOBLIN_FAILED")
})
