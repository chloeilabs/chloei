import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(path.join(cwd, "src/lib/request-id.ts")).href

const {
  createRequestHeaders,
  getRequestIdFromHeaders,
  resolveRequestIdFromHeaders,
} = await import(moduleUrl)

test("request id helpers preserve explicit request ids", () => {
  const headers = createRequestHeaders(
    {
      "Content-Type": "application/json",
      "X-Request-Id": "stale-request-id",
    },
    "request-1"
  )

  assert.equal(headers.get("Content-Type"), "application/json")
  assert.equal(headers.get("X-Request-Id"), "request-1")
  assert.equal(getRequestIdFromHeaders(headers), "request-1")
  assert.equal(resolveRequestIdFromHeaders(headers), "request-1")
})

test("request id helpers generate ids when headers are missing", () => {
  const requestId = resolveRequestIdFromHeaders()

  assert.equal(typeof requestId, "string")
  assert.ok(requestId.length > 0)
})
