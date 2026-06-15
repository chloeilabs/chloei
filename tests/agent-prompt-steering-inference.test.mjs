import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const steeringUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-prompt-steering.ts")
).href

const { createPromptSteeringBlocks, inferPromptTaskMode } = await import(
  steeringUrl
)

function user(content) {
  return [{ role: "user", content }]
}

test("inferPromptTaskMode does not mistake stock-up idioms for finance", () => {
  assert.equal(
    inferPromptTaskMode(user("Stock up on supplies for the trip.")),
    "general"
  )
  assert.equal(
    inferPromptTaskMode(user("That product has been out of stock for weeks.")),
    "general"
  )
  assert.equal(
    inferPromptTaskMode(
      user("I'm stocking up on canned beans before the storm.")
    ),
    "general"
  )
})

test("inferPromptTaskMode keeps personal financial advice in high_stakes", () => {
  assert.equal(
    inferPromptTaskMode(
      user("Should I buy this stock in my retirement account?")
    ),
    "high_stakes"
  )
  assert.equal(
    inferPromptTaskMode(user("Help me plan tax deductions for my LLC.")),
    "high_stakes"
  )
})

test("inferPromptTaskMode classifies high_stakes medical/security questions", () => {
  assert.equal(
    inferPromptTaskMode(user("My account got phished — what do I do?")),
    "high_stakes"
  )
  assert.equal(
    inferPromptTaskMode(
      user("I think I have an infection in my finger, what should I do?")
    ),
    "high_stakes"
  )
})

test("inferPromptTaskMode classifies debugging tasks distinctly from coding", () => {
  assert.equal(
    inferPromptTaskMode(
      user("My deploy script throws ENOENT, here's the trace…")
    ),
    "debugging"
  )
  assert.equal(
    inferPromptTaskMode(
      user("Why does the prod build fail with an undefined property error?")
    ),
    "debugging"
  )
  assert.equal(
    inferPromptTaskMode(
      user("The agent stream hangs at step 4 — what could cause a deadlock?")
    ),
    "debugging"
  )
  assert.equal(
    inferPromptTaskMode(
      user(
        "TypeError: cannot read property 'name' of undefined — where do I start?"
      )
    ),
    "debugging"
  )
})

test("inferPromptTaskMode still classifies pure coding requests as coding", () => {
  assert.equal(
    inferPromptTaskMode(
      user("Write a TypeScript function to debounce an async callback.")
    ),
    "coding"
  )
  assert.equal(
    inferPromptTaskMode(user("Implement a quicksort in Python.")),
    "coding"
  )
})

test("inferPromptTaskMode classifies writing tasks", () => {
  assert.equal(
    inferPromptTaskMode(
      user("Draft a release note for the new long-term memory feature.")
    ),
    "writing"
  )
  assert.equal(
    inferPromptTaskMode(user("Proofread this paragraph and tighten the tone.")),
    "writing"
  )
  assert.equal(
    inferPromptTaskMode(user("Edit my cover letter for clarity.")),
    "writing"
  )
})

test("inferPromptTaskMode classifies research requests", () => {
  assert.equal(
    inferPromptTaskMode(
      user(
        "What's the latest reporting on the EU AI Act enforcement timeline? Cite sources."
      )
    ),
    "research"
  )
  assert.equal(
    inferPromptTaskMode(
      user("Look up the current market share of Llama 3 derivatives.")
    ),
    "research"
  )
})

test("inferPromptTaskMode routes closed-answer and strict-format prompts", () => {
  assert.equal(
    inferPromptTaskMode(
      user(
        "Multiple choice: which option is correct? A) ten B) eleven C) twelve. Final answer:"
      )
    ),
    "closed_answer"
  )
  assert.equal(
    inferPromptTaskMode(
      user("Return only valid JSON with keys name and count.")
    ),
    "instruction_following"
  )
})

test("inferPromptTaskMode falls back to general when nothing matches", () => {
  assert.equal(inferPromptTaskMode(user("Hello!")), "general")
  assert.equal(
    inferPromptTaskMode(user("Tell me a fun fact about octopuses.")),
    "general"
  )
})

test("inferPromptTaskMode never lets userExpertise downgrade high_stakes routing", () => {
  assert.equal(
    inferPromptTaskMode(
      user("Should I buy this stock in my retirement account?"),
      { userExpertise: "research" }
    ),
    "high_stakes"
  )
})

test("inferPromptTaskMode userExpertise=writing routes ambiguous prompts to writing", () => {
  assert.equal(
    inferPromptTaskMode(user("Quick thoughts on this?"), {
      userExpertise: "writing",
    }),
    "writing"
  )
})

test("provider overlays are differentiated across providers", () => {
  const moonshot = createPromptSteeringBlocks({
    provider: "moonshotai",
    taskMode: "research",
  })
    .map((block) => block.body)
    .join("\n\n")
  const alibaba = createPromptSteeringBlocks({
    provider: "alibaba",
    taskMode: "research",
  })
    .map((block) => block.body)
    .join("\n\n")

  assert.match(moonshot, /Use Kimi reasoning mode/i)
  assert.match(moonshot, /long context/i)
  assert.match(alibaba, /Use Qwen reasoning mode/i)
  assert.notEqual(
    alibaba,
    moonshot,
    "Qwen and Kimi overlays should not be byte-identical."
  )
})

test("debugging and writing overlays appear when their task modes are selected", () => {
  const debugging = createPromptSteeringBlocks({
    provider: "moonshotai",
    taskMode: "debugging",
  })
    .map((block) => block.body)
    .join("\n\n")
  const writing = createPromptSteeringBlocks({
    provider: "moonshotai",
    taskMode: "writing",
  })
    .map((block) => block.body)
    .join("\n\n")

  assert.match(debugging, /root cause/i)
  assert.match(writing, /voice.*length.*audience/i)
})
