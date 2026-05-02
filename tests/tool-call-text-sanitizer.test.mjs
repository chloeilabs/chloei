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
  assert.equal(sanitize("Normal answer"), "Normal answer")
})
