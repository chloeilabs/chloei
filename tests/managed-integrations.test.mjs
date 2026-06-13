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
const inngestEnvironmentUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/inngest/environment.ts")
).href
const inngestFunctionsPath = path.join(
  cwd,
  "src/lib/server/inngest/functions.ts"
)

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
const {
  applyInngestEnvironmentInferenceOverrides,
  resolveInngestEnvironmentInferenceOverrides,
  resolveInngestEnvironmentName,
  shouldRunInngestInlineFallback,
  shouldSendInngestEvents,
} = await import(inngestEnvironmentUrl)

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
  const original = process.env.AGENT_ASYNC_REPORTS_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.AGENT_ASYNC_REPORTS_ENABLED
    delete process.env.EDGE_CONFIG
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      asyncReportsEnabled: false,
      telemetryRecordIo: false,
      financeWorkflowsEnabled: false,
    })

    process.env.AGENT_ASYNC_REPORTS_ENABLED = "true"
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.asyncReportsEnabled, true)
    assert.equal(flags.telemetryRecordIo, false)
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_ASYNC_REPORTS_ENABLED
    } else {
      process.env.AGENT_ASYNC_REPORTS_ENABLED = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("agent feature flag resolution does not mutate shared defaults", async () => {
  const original = process.env.AGENT_ASYNC_REPORTS_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.EDGE_CONFIG
    process.env.AGENT_ASYNC_REPORTS_ENABLED = "true"
    assert.equal((await resolveAgentFeatureFlags()).asyncReportsEnabled, true)

    delete process.env.AGENT_ASYNC_REPORTS_ENABLED
    assert.equal((await resolveAgentFeatureFlags()).asyncReportsEnabled, false)
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_ASYNC_REPORTS_ENABLED
    } else {
      process.env.AGENT_ASYNC_REPORTS_ENABLED = original
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
    toEdgeConfigFlagKey("agent.async_reports.enabled"),
    "agent_async_reports_enabled"
  )
  assert.equal(
    toVercelFlagSlug("agent.async_reports.enabled"),
    "agent-async-reports-enabled"
  )
})

test("agent feature flags can read Vercel/Flags-SDK Edge Config shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      flags: {
        "agent-async-reports-enabled": true,
        "agent-telemetry-record-io": false,
        "agent-finance-workflows-enabled": true,
      },
    }

    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.asyncReportsEnabled, true)
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
        "agent.async_reports.enabled": true,
      },
    }

    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.async_reports.enabled",
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

test("async report idempotency does not derive keys from prompt text", () => {
  const source = readFileSync(
    path.join(cwd, "src/app/api/jobs/report/route.ts"),
    "utf8"
  )

  assert.match(source, /reportId = parsed\.data\.reportId \?\? randomUUID\(\)/)
  assert.doesNotMatch(source, /Buffer\.from\(parsed\.data\.prompt\)/)
  assert.doesNotMatch(source, /toString\("base64url"\)/)
})

test("async report enqueue failure isolates status update failures", () => {
  const source = readFileSync(
    path.join(cwd, "src/app/api/jobs/report/route.ts"),
    "utf8"
  )

  assert.match(source, /JOB_REPORT_STATUS_UPDATE_FAILED/)
  assert.match(
    source,
    /Failed to mark report job as failed after enqueue error/
  )
})

test("Inngest inline fallback covers report/trading routes", () => {
  assert.equal(shouldRunInngestInlineFallback({}), false)
  assert.equal(
    shouldRunInngestInlineFallback({ INNGEST_INLINE_FALLBACK: "true" }),
    true
  )

  const reportRouteSource = readFileSync(
    path.join(cwd, "src/app/api/jobs/report/route.ts"),
    "utf8"
  )
  assert.match(reportRouteSource, /JOB_REPORT_INLINE_FALLBACK/)
  assert.match(
    reportRouteSource,
    /const shouldRunInlineFallback = shouldRunInngestInlineFallback\(\)/
  )
  assert.match(reportRouteSource, /} else {\n\s+let enqueueError: unknown/)

  const tradingJobRouteSource = readFileSync(
    path.join(cwd, "src/app/api/trading-desk/jobs/route.ts"),
    "utf8"
  )
  assert.match(tradingJobRouteSource, /TRADING_DESK_JOB_INLINE_FALLBACK/)
  assert.match(tradingJobRouteSource, /shouldSendInngestEvents/)
  assert.match(
    tradingJobRouteSource,
    /shouldRunInngestInlineFallback\(\) \|\| !shouldSendInngestEvents\(\)/
  )
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

test("Inngest environment resolver uses explicit and branch names", () => {
  assert.equal(
    resolveInngestEnvironmentName({
      INNGEST_ENV: "preview-a",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    }),
    "preview-a"
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      BRANCH_NAME: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature/chloei",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    "feature/chloei"
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_TARGET_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_TARGET_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    undefined
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_TARGET_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature/chloei",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    "feature/chloei"
  )
  assert.equal(resolveInngestEnvironmentName({}), undefined)
  assert.equal(resolveInngestEnvironmentName({ VERCEL: "1" }), undefined)
})

test("Inngest environment overrides disable SDK production branch inference", () => {
  assert.deepEqual(
    resolveInngestEnvironmentInferenceOverrides({
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    {
      BRANCH_NAME: undefined,
      INNGEST_ENV: undefined,
      VERCEL_GIT_COMMIT_REF: undefined,
    }
  )
  assert.deepEqual(
    resolveInngestEnvironmentInferenceOverrides({
      BRANCH_NAME: "main",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    {
      BRANCH_NAME: undefined,
      INNGEST_ENV: undefined,
      VERCEL_GIT_COMMIT_REF: undefined,
    }
  )
  assert.equal(
    resolveInngestEnvironmentInferenceOverrides({
      VERCEL_GIT_COMMIT_REF: "feature/chloei",
      VERCEL_GIT_PRODUCTION_BRANCH: "main",
    }),
    undefined
  )
  assert.deepEqual(resolveInngestEnvironmentInferenceOverrides({}), {
    BRANCH_NAME: undefined,
    INNGEST_ENV: undefined,
    VERCEL_GIT_COMMIT_REF: undefined,
  })
})

test("Inngest environment override application clears production branch vars", () => {
  const productionEnv = {
    BRANCH_NAME: "main",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_REF: "main",
    VERCEL_GIT_PRODUCTION_BRANCH: "main",
  }

  assert.deepEqual(applyInngestEnvironmentInferenceOverrides(productionEnv), {
    BRANCH_NAME: undefined,
    INNGEST_ENV: undefined,
    VERCEL_GIT_COMMIT_REF: undefined,
  })
  assert.equal(productionEnv.BRANCH_NAME, undefined)
  assert.equal(productionEnv.VERCEL_GIT_COMMIT_REF, undefined)
  assert.equal(productionEnv.VERCEL_ENV, "production")
  assert.equal(productionEnv.VERCEL_GIT_PRODUCTION_BRANCH, "main")

  const branchEnv = {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "feature/chloei",
    VERCEL_GIT_PRODUCTION_BRANCH: "main",
  }
  assert.equal(applyInngestEnvironmentInferenceOverrides(branchEnv), undefined)
  assert.equal(branchEnv.VERCEL_GIT_COMMIT_REF, "feature/chloei")
})

test("Inngest event sender requires a key and known environment", () => {
  assert.equal(shouldSendInngestEvents({}), false)
  assert.equal(
    shouldSendInngestEvents({
      INNGEST_EVENT_KEY: "event-key",
    }),
    false
  )
  assert.equal(
    shouldSendInngestEvents({
      INNGEST_EVENT_KEY: "event-key",
      INNGEST_ENV: "preview-a",
    }),
    true
  )
  assert.equal(
    shouldSendInngestEvents({
      INNGEST_EVENT_KEY: "event-key",
      VERCEL: "1",
    }),
    true
  )
  assert.equal(
    shouldSendInngestEvents({
      INNGEST_EVENT_KEY: "event-key",
      INNGEST_DEV: "true",
    }),
    true
  )
})

test("Inngest registers a side-effect-free ops smoke function", () => {
  const source = readFileSync(inngestFunctionsPath, "utf8")

  assert.match(source, /export const opsInngestSmoke = inngest\.createFunction/)
  assert.match(source, /id: "ops-inngest-smoke"/)
  assert.match(source, /event: "ops\/inngest\.smoke"/)
  assert.match(source, /step\.run\("record-smoke"/)
  assert.match(
    source,
    /export const inngestFunctions = \[[\s\S]*opsInngestSmoke[\s\S]*\]/
  )
})
