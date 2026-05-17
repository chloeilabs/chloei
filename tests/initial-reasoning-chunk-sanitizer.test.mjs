import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/initial-reasoning-chunk-sanitizer.ts")
).href

const {
  createInitialReasoningChunkSanitizer,
  createReasoningDisplaySanitizer,
} = await import(moduleUrl)

test("sanitizer strips a leading THINKING: label that arrives in its own chunk", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(sanitize("Thinking:"), "")
  assert.equal(sanitize(" the user wants news."), "the user wants news.")
  assert.equal(sanitize(" more text"), " more text")
})

test("sanitizer keeps buffering when the first chunk is whitespace-only", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(sanitize("\n\n"), "")
  assert.equal(sanitize("Thinking: hello"), "hello")
  assert.equal(sanitize(" world"), " world")
})

test("sanitizer releases non-label content immediately", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(sanitize("Let me look this up."), "Let me look this up.")
  assert.equal(sanitize(" Next part."), " Next part.")
})

test("sanitizer handles a single-chunk label+content", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(
    sanitize("Reasoning: check the latest figures."),
    "check the latest figures."
  )
})

test("sanitizer does not mangle prose that happens to start with Thinking/Reasoning", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(
    sanitize("Thinking about the latest figures."),
    "Thinking about the latest figures."
  )
})

test("sanitizer strips a label followed by a newline instead of a colon", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(
    sanitize("Thinking\nThe user wants current AI news."),
    "The user wants current AI news."
  )
})

test("sanitizer buffers a split partial label that arrives after leading whitespace", () => {
  const sanitize = createInitialReasoningChunkSanitizer()

  assert.equal(sanitize("          \nreasonin"), "")
  assert.equal(sanitize("g: hello"), "hello")
})

test("display sanitizer redacts private prompt terminology", () => {
  const sanitize = createReasoningDisplaySanitizer()

  assert.equal(
    sanitize("Reasoning: use SOUL.md and the system prompt."),
    "use private identity guidance and the private instructions."
  )
})

test("display sanitizer redacts split private prompt terminology", () => {
  const sanitize = createReasoningDisplaySanitizer()

  assert.equal(sanitize("Check SO"), "Check ")
  assert.equal(
    sanitize("UL.md before answering."),
    "private identity guidance before answering."
  )
})

test("display sanitizer flushes harmless held suffixes at stream end", () => {
  const sanitize = createReasoningDisplaySanitizer()

  assert.equal(
    sanitize("The answer depends on the system"),
    "The answer depends on the "
  )
  assert.equal(sanitize.flush(), "system")
  assert.equal(sanitize.flush(), "")
})
