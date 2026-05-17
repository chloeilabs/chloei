import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/agent-stream-events.ts")
).href

const {
  getResponseErrorMessage,
  parseStreamEventLine,
  readResponseStreamLines,
} = await import(moduleUrl)

test("parseStreamEventLine parses tool calls with checkpoint fields", () => {
  const line = JSON.stringify({
    type: "tool_call",
    callId: "call-1",
    toolName: "web_search",
    label: "  Tavily search  ",
    query: " latest ai sdk ",
    operation: "web_search",
    provider: "ai_gateway",
    attempt: 1,
    interactionId: "interaction-1",
    lastEventId: "event-1",
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "tool_call",
    callId: "call-1",
    toolName: "web_search",
    label: "Tavily search",
    query: "latest ai sdk",
    operation: "web_search",
    provider: "ai_gateway",
    attempt: 1,
    interactionId: "interaction-1",
    lastEventId: "event-1",
  })
})

test("parseStreamEventLine parses extended tool result metadata", () => {
  const line = JSON.stringify({
    type: "tool_result",
    callId: "call-1",
    toolName: "finance_data",
    status: "error",
    operation: "quote",
    provider: "fmp",
    durationMs: 42,
    errorCode: "HTTP_429",
    retryable: true,
    artifactManifest: [
      {
        path: "finance_artifact.xlsx",
        sizeBytes: 1024,
        url: "/api/agent/artifacts/run-1/finance_artifact.xlsx",
      },
    ],
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "tool_result",
    callId: "call-1",
    toolName: "finance_data",
    status: "error",
    operation: "quote",
    provider: "fmp",
    durationMs: 42,
    errorCode: "HTTP_429",
    retryable: true,
    artifactManifest: [
      {
        path: "finance_artifact.xlsx",
        sizeBytes: 1024,
        url: "/api/agent/artifacts/run-1/finance_artifact.xlsx",
      },
    ],
  })
})

test("parseStreamEventLine parses generative UI tool parts", () => {
  const line = JSON.stringify({
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
    interactionId: "interaction-1",
  })

  assert.deepEqual(parseStreamEventLine(line), {
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
    interactionId: "interaction-1",
  })
})

test("parseStreamEventLine rejects malformed checkpoint and tool data", () => {
  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "tool_call",
        callId: "call-1",
        toolName: "not-a-tool",
        label: "Search",
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "agent_status",
        status: "completed",
        interactionId: "   ",
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "tool_result",
        callId: "call-1",
        toolName: "finance_data",
        status: "error",
        operation: "   ",
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "tool_result",
        callId: "call-1",
        toolName: "code_execution",
        status: "success",
        artifactManifest: [{ path: "../escape.xlsx", sizeBytes: 1 }],
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "tool_result",
        callId: "call-1",
        toolName: "code_execution",
        status: "success",
        artifactManifest: [
          {
            path: "finance_artifact.xlsx",
            sizeBytes: 1,
            url: "https://example.com/finance_artifact.xlsx",
          },
        ],
      })
    ),
    null
  )

  assert.equal(
    parseStreamEventLine(
      JSON.stringify({
        type: "generative_ui",
        part: {
          type: "tool-display_stock",
          toolCallId: "call-stock",
          state: "output-available",
          input: {
            symbol: "AAPL",
          },
          output: {
            symbol: "AAPL",
            price: "not-a-number",
          },
        },
      })
    ),
    null
  )
})

test("getResponseErrorMessage prefers JSON error and falls back to body text", async () => {
  const jsonResponse = new Response(
    JSON.stringify({ error: "Unauthorized." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    }
  )
  const textResponse = new Response("Service unavailable", {
    status: 503,
  })
  const emptyResponse = new Response(null, {
    status: 429,
  })

  await assert.doesNotReject(async () => {
    assert.equal(await getResponseErrorMessage(jsonResponse), "Unauthorized.")
    assert.equal(
      await getResponseErrorMessage(textResponse),
      "Service unavailable"
    )
    assert.equal(
      await getResponseErrorMessage(emptyResponse),
      "Request failed (429)"
    )
  })
})

test("readResponseStreamLines reassembles chunked lines and preserves final partial line", async () => {
  const encoder = new TextEncoder()
  const receivedLines = []

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("alpha\nbe"))
      controller.enqueue(encoder.encode("ta\ngamma"))
      controller.close()
    },
  })

  await readResponseStreamLines(stream, (line, appendNewline) => {
    receivedLines.push({ line, appendNewline })
  })

  assert.deepEqual(receivedLines, [
    { line: "alpha", appendNewline: true },
    { line: "beta", appendNewline: true },
    { line: "gamma", appendNewline: false },
  ])
})
