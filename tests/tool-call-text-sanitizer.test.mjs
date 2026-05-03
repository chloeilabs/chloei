import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const sanitizerUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/tool-call-text-sanitizer.ts")
).href

const { createToolCallTextSanitizer } = await import(sanitizerUrl)

test("tool call text sanitizer strips single-chunk DSML tool calls", () => {
  const sanitize = createToolCallTextSanitizer()
  const leakedToolCall =
    '<| DSML | tool_calls><| DSML | invoke name="code_execution"><| DSML | parameter name="code" string="true">print("BEAR, BASE, BULL")<| DSML | parameter><| DSML | invoke><| DSML | tool_calls>'

  assert.equal(sanitize(`Before ${leakedToolCall} After`), "Before  After")
})

test("tool call text sanitizer preserves content between multiple DSML blocks", () => {
  const sanitize = createToolCallTextSanitizer()
  const firstBlock =
    '<| DSML | tool_calls><| DSML | invoke name="code_execution">hidden<| DSML | tool_calls>'
  const secondBlock =
    '<| DSML | tool_calls><| DSML | invoke name="finance_data">hidden<| DSML | tool_calls>'

  assert.equal(
    sanitize(`Before ${firstBlock} Middle ${secondBlock} After`),
    "Before  Middle  After"
  )
})

test("tool call text sanitizer buffers split DSML tool calls", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(
    sanitize('<| DSML | tool_calls><| DSML | invoke name="code_execution">'),
    ""
  )
  assert.equal(
    sanitize(
      '<| DSML | parameter name="code" string="true">print("BEAR")<| DSML | tool_calls>'
    ),
    ""
  )
  assert.equal(sanitize("Visible answer."), "Visible answer.")
})

test("tool call text sanitizer drops orphan pseudo-tool markers", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(
    sanitize('| DSML | invoke name="code_execution" parameter name="code"'),
    ""
  )
  assert.equal(
    sanitize('invoke name="code_execution" parameter name="code"'),
    ""
  )
  assert.equal(sanitize("Normal answer"), "Normal answer")
})

test("tool call text sanitizer preserves inline marker-like prose", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(
    sanitize("You can invoke name= directly in this DSL."),
    "You can invoke name= directly in this DSL."
  )
})

test("tool call text sanitizer preserves leading non-DSML marker prose", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(
    sanitize("invoke name= can appear in documentation."),
    "invoke name= can appear in documentation."
  )
})

test("tool call text sanitizer buffers split marker prefixes", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(sanitize("Visible <| DS"), "Visible ")
  assert.equal(
    sanitize('ML | tool_calls><| DSML | invoke name="code_execution">'),
    ""
  )
  assert.equal(
    sanitize('<| DSML | parameter name="code">print("hidden")<| DSML | tool_'),
    ""
  )
  assert.equal(sanitize("calls> Final answer."), " Final answer.")
})

test("tool call text sanitizer releases non-marker buffered text", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(sanitize("Please invo"), "Please ")
  assert.equal(sanitize("ice the customer."), "invoice the customer.")
})

test("tool call text sanitizer flushes final visible marker-like prefixes", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(sanitize("Final total <"), "Final total ")
  assert.equal(sanitize.flush(), "<")
  assert.equal(sanitize.flush(), "")
})

test("tool call text sanitizer drops unfinished tool blocks on flush", () => {
  const sanitize = createToolCallTextSanitizer()

  assert.equal(
    sanitize('<| DSML | tool_calls><| DSML | invoke name="code_execution">'),
    ""
  )
  assert.equal(sanitize.flush(), "")
})
