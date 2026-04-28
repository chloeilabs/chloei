import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const attachmentsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/agent/attachments.ts")
).href

const {
  getAgentAttachmentKind,
  isAgentAttachmentPreviewDataUrl,
  isSupportedAgentAttachmentMimeType,
  normalizeAgentAttachmentMimeType,
} = await import(attachmentsUrl)

test("agent attachment MIME helpers normalize before kind detection", () => {
  assert.equal(normalizeAgentAttachmentMimeType("IMAGE/PNG"), "image/png")
  assert.equal(isSupportedAgentAttachmentMimeType("IMAGE/PNG"), true)
  assert.equal(getAgentAttachmentKind("IMAGE/PNG"), "image")
  assert.equal(getAgentAttachmentKind("APPLICATION/PDF"), "pdf")
})

test("agent attachment preview data URLs only allow supported image payloads", () => {
  assert.equal(
    isAgentAttachmentPreviewDataUrl("data:image/jpeg;base64,abc="),
    true
  )
  assert.equal(
    isAgentAttachmentPreviewDataUrl("data:application/pdf;base64,abc="),
    false
  )
  assert.equal(
    isAgentAttachmentPreviewDataUrl("https://example.com/a.png"),
    false
  )
})
