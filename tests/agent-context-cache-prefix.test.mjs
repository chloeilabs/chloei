import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-context.ts")
).href

const { buildAgentSystemInstruction } = await import(moduleUrl)

const viewer = { id: "user-1", name: "Ada", email: "ada@example.com" }

function build(now, overrides = {}) {
  return buildAgentSystemInstruction(overrides.viewer ?? viewer, {
    now,
    userTimeZone: "UTC",
    provider: "openai",
  })
}

const authMarker = "BEGIN AUTH USER CONTEXT"
const dateMarker = "BEGIN RUNTIME DATE CONTEXT"

test("system prompt orders volatile blocks (auth, then date) last", () => {
  const out = build(new Date("2026-06-28T00:00:00.000Z"))

  const operatingIdx = out.indexOf("BEGIN OPERATING INSTRUCTIONS")
  const identityIdx = out.indexOf("BEGIN IDENTITY AND TONE CONTEXT")
  const authIdx = out.indexOf(authMarker)
  const dateIdx = out.indexOf(dateMarker)

  assert.ok(operatingIdx >= 0, "operating instructions block present")
  assert.ok(
    identityIdx > operatingIdx,
    "identity block present after operating"
  )
  assert.ok(authIdx > identityIdx, "auth block present after identity")
  assert.ok(
    dateIdx > authIdx,
    "RUNTIME DATE CONTEXT must come after AUTH USER CONTEXT so the per-request timestamp does not bust the cacheable prefix"
  )
})

test("the stable prefix is byte-identical across different now timestamps", () => {
  const a = build(new Date("2026-06-28T00:00:00.000Z"))
  const b = build(new Date("2030-01-01T12:34:56.000Z"))

  // Everything before the per-user auth block (operating + provider overlay +
  // identity/tone) must not vary with the wall clock — that's the cacheable
  // prefix shared across all users and requests.
  const prefix = (s) => s.slice(0, s.indexOf(authMarker))

  assert.equal(
    prefix(a),
    prefix(b),
    "the shared prefix before AUTH must be stable across requests"
  )
})

test("the prefix through the auth block is stable for the same user across requests", () => {
  const a = build(new Date("2026-06-28T00:00:00.000Z"))
  const b = build(new Date("2030-01-01T12:34:56.000Z"))

  // For a single user, the prefix up to (but not including) the per-request
  // date block stays identical — only the trailing date block changes.
  const prefix = (s) => s.slice(0, s.indexOf(dateMarker))

  assert.equal(
    prefix(a),
    prefix(b),
    "the per-user prefix before RUNTIME DATE CONTEXT must be stable across requests"
  )
})
