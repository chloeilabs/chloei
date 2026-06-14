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
    toolName: "tavily_search",
    label: "  Tavily search  ",
    query: " latest ai sdk ",
    operation: "tavily_search",
    provider: "ai_gateway",
    attempt: 1,
    interactionId: "interaction-1",
    lastEventId: "event-1",
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "tool_call",
    callId: "call-1",
    toolName: "tavily_search",
    label: "Tavily search",
    query: "latest ai sdk",
    operation: "tavily_search",
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
    toolName: "code_execution",
    status: "error",
    operation: "python",
    provider: "local",
    durationMs: 42,
    errorCode: "EXIT_NON_ZERO",
    retryable: true,
    artifactManifest: [
      {
        path: "model_output.xlsx",
        sizeBytes: 1024,
        url: "/api/agent/artifacts/run-1/model_output.xlsx",
      },
    ],
  })

  assert.deepEqual(parseStreamEventLine(line), {
    type: "tool_result",
    callId: "call-1",
    toolName: "code_execution",
    status: "error",
    operation: "python",
    provider: "local",
    durationMs: 42,
    errorCode: "EXIT_NON_ZERO",
    retryable: true,
    artifactManifest: [
      {
        path: "model_output.xlsx",
        sizeBytes: 1024,
        url: "/api/agent/artifacts/run-1/model_output.xlsx",
      },
    ],
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
        toolName: "tavily_search",
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
            path: "model_output.xlsx",
            sizeBytes: 1,
            url: "https://example.com/model_output.xlsx",
          },
        ],
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
