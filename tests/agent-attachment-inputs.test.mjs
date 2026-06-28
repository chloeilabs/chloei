import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

// agent-runtime-messages.ts type-imports @openai/agents; the loader still
// resolves the module, so stub it to avoid its heavy CJS deps.
setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
})

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-messages.ts")
).href

const { toAgentInputItems } = await import(moduleUrl)

test("a fileId attachment maps to an input_file reference, not base64", () => {
  const items = toAgentInputItems([
    {
      role: "user",
      content: "Read this",
      attachments: [
        {
          id: "a1",
          kind: "pdf",
          name: "report.pdf",
          mediaType: "application/pdf",
          fileId: "file-xyz",
          // A stale base64 url must be ignored once a fileId exists.
          url: "data:application/pdf;base64,SHOULD_NOT_BE_USED",
        },
      ],
    },
  ])

  assert.deepEqual(items[0].content, [
    { type: "input_text", text: "Read this" },
    { type: "input_file", file: { id: "file-xyz" }, filename: "report.pdf" },
  ])
})

test("an image fileId attachment maps to input_image { id }", () => {
  const items = toAgentInputItems([
    {
      role: "user",
      content: "",
      attachments: [
        {
          id: "a1",
          kind: "image",
          name: "p.png",
          mediaType: "image/png",
          fileId: "file-img",
        },
      ],
    },
  ])

  assert.deepEqual(items[0].content, [
    { type: "input_image", image: { id: "file-img" } },
  ])
})

test("an attachment with only a base64 url still maps inline", () => {
  const items = toAgentInputItems([
    {
      role: "user",
      content: "Look",
      attachments: [
        {
          id: "a1",
          kind: "image",
          name: "p.png",
          mediaType: "image/png",
          url: "data:image/png;base64,AAAA",
        },
      ],
    },
  ])

  assert.deepEqual(items[0].content, [
    { type: "input_text", text: "Look" },
    { type: "input_image", image: "data:image/png;base64,AAAA" },
  ])
})

test("an attachment with neither url nor fileId is dropped", () => {
  const items = toAgentInputItems([
    {
      role: "user",
      content: "Hello",
      attachments: [
        { id: "a1", kind: "image", name: "p.png", mediaType: "image/png" },
      ],
    },
  ])

  assert.deepEqual(items, [{ role: "user", content: "Hello" }])
})
