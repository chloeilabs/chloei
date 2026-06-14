import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
  "@vercel/edge-config": toProjectFileUrl("tests/stubs/edge-config.mjs"),
})

const edgeConfigStoreKey = Symbol.for("chloei.tests.edge-config-store")

const privateBlobStorageUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/private-blob-storage.ts")
).href
const agentAttachmentBlobsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-attachment-blobs.ts")
).href
const pdfTextExtractionUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/pdf-text-extraction.ts")
).href
const integrationFlagsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/integration-flags.ts")
).href

const {
  buildAuthenticatedPrivateBlobDownloadUrl,
  buildPrivateBlobAttachmentPathname,
  isUserOwnedBlobPathname,
  normalizeBlobPathname,
} = await import(privateBlobStorageUrl)
const { hydrateBlobBackedAttachments } = await import(agentAttachmentBlobsUrl)
const { normalizeExtractedReadableText } = await import(pdfTextExtractionUrl)
const {
  resolveAgentFeatureFlags,
  resolveIntegrationBooleanFlag,
  toEdgeConfigFlagKey,
  toVercelFlagSlug,
} = await import(integrationFlagsUrl)

test("private Blob path helpers keep downloads user-scoped", () => {
  const attachmentId = "01989a40-465d-45c2-8506-b8ddb940b9ad"
  const pathname = buildPrivateBlobAttachmentPathname({
    userId: "user-1",
    filename: "statement Q1.pdf",
    attachmentId,
  })

  assert.equal(normalizeBlobPathname("../escape.pdf"), null)
  assert.match(pathname, new RegExp(`/attachments/${attachmentId}/`))
  assert.equal(isUserOwnedBlobPathname({ pathname, userId: "user-1" }), true)
  assert.equal(isUserOwnedBlobPathname({ pathname, userId: "user-2" }), false)
  assert.equal(
    buildAuthenticatedPrivateBlobDownloadUrl(pathname),
    `/api/uploads/${pathname
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`
  )
  assert.throws(() =>
    buildPrivateBlobAttachmentPathname({
      userId: "user-1",
      filename: "statement.pdf",
      attachmentId: "foo/bar",
    })
  )
})

test("readable text normalization preserves document layout for model prompts", () => {
  const readable = normalizeExtractedReadableText(
    "Title\r\n\r\nRow 1    Value A\tValue B  \n\n\n\nRow 2\u0000Value C"
  )

  assert.equal(
    readable,
    "Title\n\nRow 1    Value A\tValue B\n\n\nRow 2 Value C"
  )
})

test("agent feature flags default off and respect explicit env overrides", async () => {
  const original = process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
    delete process.env.EDGE_CONFIG
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      telemetryRecordIo: false,
      financeWorkflowsEnabled: false,
    })

    process.env.AGENT_FINANCE_WORKFLOWS_ENABLED = "true"
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.financeWorkflowsEnabled, true)
    assert.equal(flags.telemetryRecordIo, false)
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
    } else {
      process.env.AGENT_FINANCE_WORKFLOWS_ENABLED = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("agent feature flag resolution does not mutate shared defaults", async () => {
  const original = process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.EDGE_CONFIG
    process.env.AGENT_FINANCE_WORKFLOWS_ENABLED = "true"
    assert.equal(
      (await resolveAgentFeatureFlags()).financeWorkflowsEnabled,
      true
    )

    delete process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
    assert.equal(
      (await resolveAgentFeatureFlags()).financeWorkflowsEnabled,
      false
    )
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_FINANCE_WORKFLOWS_ENABLED
    } else {
      process.env.AGENT_FINANCE_WORKFLOWS_ENABLED = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("Edge Config flag keys are compatible with Vercel key restrictions", () => {
  assert.equal(
    toEdgeConfigFlagKey("agent.finance_workflows.enabled"),
    "agent_finance_workflows_enabled"
  )
  assert.equal(
    toVercelFlagSlug("agent.finance_workflows.enabled"),
    "agent-finance-workflows-enabled"
  )
})

test("agent feature flags can read Vercel/Flags-SDK Edge Config shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      flags: {
        "agent-telemetry-record-io": false,
        "agent-finance-workflows-enabled": true,
      },
    }

    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.telemetryRecordIo, false)
    assert.equal(flags.financeWorkflowsEnabled, true)
  } finally {
    delete globalThis[edgeConfigStoreKey]
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("integration boolean flags can read Edge Config map shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      agent_flags: {
        "agent.finance_workflows.enabled": true,
      },
    }

    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.finance_workflows.enabled",
      }),
      true
    )
  } finally {
    delete globalThis[edgeConfigStoreKey]
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("private upload route validates client-supplied attachment ids", () => {
  const source = readFileSync(
    path.join(cwd, "src/app/api/uploads/route.ts"),
    "utf8"
  )

  assert.match(source, /ATTACHMENT_ID_PATTERN/)
  assert.match(source, /UPLOAD_ATTACHMENT_ID_INVALID/)
})

test("blob-backed attachment hydration omits unreadable blobs", async () => {
  const messages = await hydrateBlobBackedAttachments({
    userId: "user-1",
    messages: [
      {
        role: "user",
        content: "Please inspect this.",
        attachments: [
          {
            id: "attachment-1",
            kind: "pdf",
            filename: "statement.pdf",
            mediaType: "application/pdf",
            sizeBytes: 10,
            blobPathname: "../bad.pdf",
            sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      },
    ],
  })

  assert.deepEqual(messages[0].attachments, [])
})

test("agent attachment validation requires exactly one payload form", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/agent-route.ts"),
    "utf8"
  )

  assert.match(source, /hasInlinePayload === hasBlobPayload/)
  assert.match(source, /hasBlobPathname !== hasBlobSha256/)
})

test("prompt attachment uploads validate API response shape", () => {
  const source = readFileSync(
    path.join(cwd, "src/components/agent/prompt-form/attachments.ts"),
    "utf8"
  )

  assert.match(source, /UploadAttachmentResponseSchema/)
  assert.match(source, /safeParse\(\s*await response\.json\(\)\s*\)/)
})

test("code execution artifact collection catches best-effort file-read failures", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/llm/code-execution-tools.ts"),
    "utf8"
  )

  assert.match(
    source,
    /readFile\(\s*(?:\/\*turbopackIgnore: true\*\/\s*)?fullPath\s*\)\.catch\(\(\) => null\)/
  )
})

test("private blob uploads return authenticated app download URLs", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/private-blob-storage.ts"),
    "utf8"
  )

  assert.match(source, /ATTACHMENT_ID_SCHEMA = z\.uuid\(\)/)
  assert.match(
    source,
    /buildAuthenticatedPrivateBlobDownloadUrl\(result\.pathname\)/
  )
  assert.doesNotMatch(source, /downloadUrl: result\.downloadUrl/)
})
