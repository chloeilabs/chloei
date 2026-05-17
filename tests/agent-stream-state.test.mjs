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

test("tool result events clear artifact manifests with explicit empty arrays", () => {
  const started = applyAgentStreamEvent(createAgentStreamAccumulator(), {
    type: "tool_call",
    callId: "call-1",
    toolName: "code_execution",
    label: "Running Python",
    artifactManifest: [
      {
        path: "model.xlsx",
        sizeBytes: 10,
        url: "/api/agent/artifacts/run-1/model.xlsx",
      },
    ],
  })

  const completed = applyAgentStreamEvent(started, {
    type: "tool_result",
    callId: "call-1",
    toolName: "code_execution",
    status: "success",
    artifactManifest: [],
  })

  assert.deepEqual(completed.toolInvocations[0]?.artifactManifest, [])
  assert.equal(completed.activityTimeline[0]?.kind, "tool")
  assert.deepEqual(completed.activityTimeline[0]?.artifactManifest, [])
})

test("generative UI parts preserve order and update by tool call", () => {
  const withIntro = applyAgentStreamEvent(createAgentStreamAccumulator(), {
    type: "text_delta",
    delta: "Here is the forecast.",
  })
  const loading = applyAgentStreamEvent(withIntro, {
    type: "generative_ui",
    part: {
      type: "tool-display_weather",
      toolCallId: "call-weather",
      state: "input-available",
      input: {
        location: "Chicago",
        unit: "fahrenheit",
      },
    },
  })
  const completed = applyAgentStreamEvent(loading, {
    type: "generative_ui",
    part: {
      type: "tool-display_weather",
      toolCallId: "call-weather",
      state: "output-available",
      input: {
        location: "Chicago",
        unit: "fahrenheit",
      },
      output: {
        location: "Chicago",
        resolvedLocation: "Chicago, Illinois, United States",
        latitude: 41.85,
        longitude: -87.65,
        unit: "fahrenheit",
        condition: "Clear",
        temperature: 72,
        feelsLike: 73,
        humidity: 45,
        windSpeed: 8,
        windDirection: 270,
        observedAt: "2026-05-16T10:00",
        forecast: [
          {
            date: "2026-05-16",
            condition: "Clear",
            temperatureMax: 76,
            temperatureMin: 61,
            precipitationProbability: 10,
          },
        ],
        provider: "open-meteo",
        sourceUrl: "https://api.open-meteo.com/v1/forecast?latitude=41.85",
      },
    },
  })

  assert.equal(completed.content, "Here is the forecast.")
  assert.equal(completed.parts.length, 2)
  assert.equal(completed.parts[0]?.type, "text")
  assert.equal(completed.parts[1]?.type, "tool-display_weather")
  assert.equal(completed.parts[1]?.state, "output-available")
})
