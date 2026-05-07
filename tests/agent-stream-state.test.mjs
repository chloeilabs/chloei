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
