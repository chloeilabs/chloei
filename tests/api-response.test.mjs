import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const helperUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/api-response.ts")
).href

const { createApiErrorResponse, createApiHeaders } = await import(helperUrl)

test("api response helpers preserve stable observability headers", async () => {
  const headers = createApiHeaders({
    headers: {
      "X-Custom-Header": "custom-value",
      "X-Request-Id": "ignored-request-id",
    },
    requestId: "request-1",
  })

  assert.equal(headers.get("Cache-Control"), "no-store")
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff")
  assert.equal(headers.get("X-Custom-Header"), "custom-value")
  assert.equal(headers.get("X-Request-Id"), "request-1")

  const response = createApiErrorResponse({
    requestId: "request-2",
    error: "Bad request.",
    errorCode: "TEST_BAD_REQUEST",
    status: 400,
    headers: {
      "X-Custom-Header": "custom-value",
      "X-Request-Id": "stale-request-id",
    },
  })

  assert.equal(response.status, 400)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff")
  assert.equal(response.headers.get("X-Custom-Header"), "custom-value")
  assert.equal(response.headers.get("X-Error-Code"), "TEST_BAD_REQUEST")
  assert.equal(response.headers.get("X-Request-Id"), "request-2")
  assert.deepEqual(await response.json(), {
    error: "Bad request.",
    errorCode: "TEST_BAD_REQUEST",
    requestId: "request-2",
  })
})
