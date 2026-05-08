import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const memoryUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/memory/format.ts")
).href
const agentContextUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-context.ts")
).href

const { formatMemoryBlock } = await import(memoryUrl)
const { buildAgentSystemInstruction } = await import(agentContextUrl)

test("formatMemoryBlock returns empty string when there are no records", () => {
  assert.equal(formatMemoryBlock([]), "")
})

test("formatMemoryBlock renders a labeled bullet list with guidance", () => {
  const block = formatMemoryBlock([
    {
      id: "a",
      fact: "The user prefers Python for data analysis.",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "b",
      fact: "The user lives in Austin, Texas.",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ])

  assert.match(block, /# Long-Term User Memory/)
  assert.match(block, /durable facts about the authenticated user/)
  assert.match(block, /- The user prefers Python for data analysis\./)
  assert.match(block, /- The user lives in Austin, Texas\./)
  assert.match(block, /If a fact contradicts new information from the user, trust the user\./)
})

test("buildAgentSystemInstruction wraps the user memory block in delimiters", () => {
  const block = formatMemoryBlock([
    {
      id: "a",
      fact: "The user prefers Python for data analysis.",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ])

  const prompt = buildAgentSystemInstruction(
    {
      id: "user-1",
      name: "Chloei",
      email: "user@example.com",
    },
    {
      now: new Date("2026-05-03T12:34:56.000Z"),
    },
    {
      userMemoryBlock: block,
    }
  )

  const memoryStart = prompt.indexOf("--- BEGIN USER MEMORY ---")
  const memoryEnd = prompt.indexOf("--- END USER MEMORY ---")
  assert.ok(memoryStart > -1, "expected USER MEMORY block to be present")
  assert.ok(memoryEnd > memoryStart, "expected USER MEMORY block to terminate")
  assert.match(
    prompt.slice(memoryStart, memoryEnd),
    /The user prefers Python for data analysis\./
  )
})

test("buildAgentSystemInstruction omits the memory block when empty", () => {
  const prompt = buildAgentSystemInstruction(
    {
      id: "user-1",
      name: "Chloei",
      email: "user@example.com",
    },
    {
      now: new Date("2026-05-03T12:34:56.000Z"),
    },
    {
      userMemoryBlock: "",
    }
  )

  assert.equal(prompt.includes("--- BEGIN USER MEMORY ---"), false)
})
