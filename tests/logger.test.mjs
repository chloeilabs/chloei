import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const loggerUrl = pathToFileURL(path.join(cwd, "src/lib/logger.ts")).href

const { createLogger } = await import(loggerUrl)

test("logger normalizes nested errors before emitting", () => {
  const recordedCalls = []
  const originalConsoleError = console.error
  const rootCause = new Error("Root cause.")
  const error = Object.assign(new Error("Primary failure."), {
    code: "E_RUNTIME",
    status: 502,
    cause: rootCause,
  })

  console.error = (...args) => {
    recordedCalls.push(args)
  }

  try {
    createLogger("runtime").error("Request failed.", {
      error,
      errorCode: "REQUEST_FAILED",
      requestId: "request-1",
    })
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(recordedCalls.length, 1)

  const [message, details] = recordedCalls[0]

  assert.equal(message, "[runtime] Request failed.")
  assert.equal(details.errorCode, "REQUEST_FAILED")
  assert.equal(details.requestId, "request-1")
  assert.equal(details.error.name, "Error")
  assert.equal(details.error.message, "Primary failure.")
  assert.equal(details.error.code, "E_RUNTIME")
  assert.equal(details.error.status, 502)
  assert.equal(typeof details.error.stack, "string")
  assert.equal(details.error.cause.name, "Error")
  assert.equal(details.error.cause.message, "Root cause.")
  assert.equal(typeof details.error.cause.stack, "string")
})
