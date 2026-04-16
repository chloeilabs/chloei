import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const loggerUrl = pathToFileURL(path.join(cwd, "src/lib/logger.ts")).href
const httpErrorUrl = pathToFileURL(path.join(cwd, "src/lib/http-error.ts")).href

const { createLogger } = await import(loggerUrl)
const { createHttpError } = await import(httpErrorUrl)

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

test("logger preserves request metadata from thrown http errors", () => {
  const recordedCalls = []
  const originalConsoleError = console.error
  const error = createHttpError({
    message: "Failed to fetch threads.",
    status: 503,
    errorCode: "THREADS_FETCH_FAILED",
    requestId: "request-1",
  })

  console.error = (...args) => {
    recordedCalls.push(args)
  }

  try {
    createLogger("runtime").error("API request failed.", error)
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(recordedCalls.length, 1)

  const [message, details] = recordedCalls[0]

  assert.equal(message, "[runtime] API request failed.")
  assert.equal(details.error.message, "Failed to fetch threads.")
  assert.equal(details.error.status, 503)
  assert.equal(details.error.errorCode, "THREADS_FETCH_FAILED")
  assert.equal(details.error.requestId, "request-1")
})

test("logger emits structured json on the server in production", () => {
  const recordedCalls = []
  const originalNodeEnv = process.env.NODE_ENV
  const originalStdoutWrite = process.stdout.write

  process.env.NODE_ENV = "production"
  process.stdout.write = (chunk, encoding, callback) => {
    recordedCalls.push(String(chunk))

    if (typeof encoding === "function") {
      encoding()
    } else if (typeof callback === "function") {
      callback()
    }

    return true
  }

  try {
    createLogger("api").info("API request completed.", {
      requestId: "request-1",
      route: "/api/models",
      method: "GET",
      status: 200,
      durationMs: 42,
      outcome: "success",
    })
  } finally {
    process.stdout.write = originalStdoutWrite
    process.env.NODE_ENV = originalNodeEnv
  }

  assert.equal(recordedCalls.length, 1)

  const payload = JSON.parse(recordedCalls[0])

  assert.equal(payload.level, "info")
  assert.equal(payload.scope, "api")
  assert.equal(payload.message, "API request completed.")
  assert.equal(payload.requestId, "request-1")
  assert.equal(payload.route, "/api/models")
  assert.equal(payload.method, "GET")
  assert.equal(payload.status, 200)
  assert.equal(payload.durationMs, 42)
  assert.equal(payload.outcome, "success")
  assert.equal(payload.details.requestId, "request-1")
})
