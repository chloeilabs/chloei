import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const contextUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-context.ts")
).href
const instructionsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/system-instructions.ts")
).href

const { buildAgentSystemInstruction } = await import(contextUrl)
const { DEFAULT_OPERATING_INSTRUCTION } = await import(instructionsUrl)

const viewer = {
  id: "user-123",
  name: "Ada Lovelace",
  email: "ada@example.com",
}
const baseContext = { now: new Date("2026-06-14T12:30:00.000Z") }

const MANDATORY_LABELS = [
  "OPERATING INSTRUCTIONS",
  "RUNTIME DATE CONTEXT",
  "IDENTITY AND TONE CONTEXT",
  "AUTH USER CONTEXT",
]

test("emits the mandatory prompt blocks, delimited and ordered", () => {
  const prompt = buildAgentSystemInstruction(viewer, baseContext)

  for (const label of MANDATORY_LABELS) {
    assert.ok(
      prompt.includes(`--- BEGIN ${label} ---`),
      `missing BEGIN ${label}`
    )
    assert.ok(prompt.includes(`--- END ${label} ---`), `missing END ${label}`)
  }

  const order = MANDATORY_LABELS.map((label) =>
    prompt.indexOf(`--- BEGIN ${label} ---`)
  )
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "blocks should appear in operating/date/identity/auth order"
  )

  assert.ok(
    prompt.includes(DEFAULT_OPERATING_INSTRUCTION.trim()),
    "expected the default operating instruction by default"
  )
})

test("renders authenticated viewer identity", () => {
  const prompt = buildAgentSystemInstruction(viewer, baseContext)

  assert.ok(prompt.includes("User ID: user-123"))
  assert.ok(prompt.includes("Name: Ada Lovelace"))
  assert.ok(prompt.includes("Email: ada@example.com"))
})

test("falls back to (not provided) for blank viewer fields", () => {
  const prompt = buildAgentSystemInstruction(
    { id: "u", name: "   ", email: "" },
    baseContext
  )

  assert.ok(prompt.includes("Name: (not provided)"))
  assert.ok(prompt.includes("Email: (not provided)"))
})

test("runtime date context is anchored to the provided timestamp", () => {
  const prompt = buildAgentSystemInstruction(viewer, baseContext)

  assert.ok(prompt.includes("Current UTC timestamp: 2026-06-14T12:30:00.000Z"))
})

test("valid user time zone is rendered and invalid is dropped", () => {
  const withZone = buildAgentSystemInstruction(viewer, {
    ...baseContext,
    userTimeZone: "America/New_York",
  })
  assert.ok(withZone.includes("User time zone: America/New_York"))
  assert.ok(withZone.includes("Current user-local time:"))

  const invalidZone = buildAgentSystemInstruction(viewer, {
    ...baseContext,
    userTimeZone: "Not/AZone",
  })
  assert.ok(!invalidZone.includes("User time zone:"))
})

test("system prompt never includes a deep research block", () => {
  const instruction = buildAgentSystemInstruction(viewer, baseContext)
  assert.ok(!instruction.includes("--- BEGIN DEEP RESEARCH MODE ---"))
})

test("provider overlay respects its toggle", () => {
  const withOverlay = buildAgentSystemInstruction(viewer, {
    ...baseContext,
    provider: "moonshotai",
  })
  assert.ok(withOverlay.includes("PROVIDER OVERLAY: MOONSHOTAI"))

  const disabled = buildAgentSystemInstruction(
    viewer,
    { ...baseContext, provider: "moonshotai" },
    { providerOverlaysEnabled: false }
  )
  assert.ok(!disabled.includes("PROVIDER OVERLAY"))
})

test("operatingInstruction override replaces the default body", () => {
  const prompt = buildAgentSystemInstruction(viewer, baseContext, {
    operatingInstruction: "CUSTOM-OPERATING-INSTRUCTION",
  })

  assert.ok(prompt.includes("CUSTOM-OPERATING-INSTRUCTION"))
  assert.ok(!prompt.includes(DEFAULT_OPERATING_INSTRUCTION.trim()))
})
