import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(path.join(cwd, "src/lib/http-error.ts")).href

const {
  createHttpErrorFromResponse,
  formatHttpErrorDescription,
  getHttpErrorMessage,
  getHttpErrorRequestId,
  parseHttpErrorResponse,
} = await import(moduleUrl)

test("http error helpers parse structured api failures", async () => {
  const response = new Response(
    JSON.stringify({
      error: "Unauthorized.",
      errorCode: "MODELS_UNAUTHORIZED",
      requestId: "request-body-1",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "X-Error-Code": "stale-header-code",
        "X-Request-Id": "stale-header-request-id",
      },
    }
  )

  const parsed = await parseHttpErrorResponse(response)

  assert.deepEqual(parsed, {
    message: "Unauthorized.",
    errorCode: "MODELS_UNAUTHORIZED",
    requestId: "request-body-1",
    status: 401,
  })
})

test("http error helpers preserve request ids for user-facing descriptions", async () => {
  const response = new Response("Service unavailable", {
    status: 503,
    headers: {
      "X-Request-Id": "request-2",
    },
  })

  const error = await createHttpErrorFromResponse(
    response,
    "Failed to load data."
  )

  assert.equal(getHttpErrorMessage(error), "Service unavailable")
  assert.equal(getHttpErrorRequestId(error), "request-2")
  assert.equal(
    formatHttpErrorDescription(error),
    "Service unavailable Reference ID: request-2"
  )
})

test("http error helpers hide html error documents", async () => {
  const response = new Response(
    '<!DOCTYPE html><html id="__next_error__"><title>500: This page could not load</title></html>',
    {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Request-Id": "request-html-1",
      },
    }
  )

  const error = await createHttpErrorFromResponse(response)

  assert.equal(getHttpErrorMessage(error), "Request failed (500)")
  assert.equal(getHttpErrorRequestId(error), "request-html-1")
  assert.equal(
    formatHttpErrorDescription(error),
    "Request failed (500) Reference ID: request-html-1"
  )
})

test("http error helpers fall back when responses are empty", async () => {
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-Error-Code": "AGENT_RATE_LIMITED",
    },
  })

  const error = await createHttpErrorFromResponse(response)

  assert.equal(getHttpErrorMessage(error), "Request failed (429)")
  assert.equal(error.errorCode, "AGENT_RATE_LIMITED")
})
