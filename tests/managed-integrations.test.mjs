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
  "posthog-node": toProjectFileUrl("tests/stubs/posthog-node.mjs"),
})

const edgeConfigStoreKey = Symbol.for("chloei.tests.edge-config-store")
const postHogCapturesKey = Symbol.for("chloei.tests.posthog-captures")

const privateBlobStorageUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/private-blob-storage.ts")
).href
const agentAttachmentBlobsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-attachment-blobs.ts")
).href
const knowledgeSearchUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-knowledge-search-tools.ts")
).href
const managedSearchUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-managed-search-tools.ts")
).href
const knowledgeIndexingUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/knowledge-indexing.ts")
).href
const integrationFlagsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/integration-flags.ts")
).href
const sentryScrubbingUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/sentry-scrubbing.ts")
).href
const postHogAnalyticsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/posthog-analytics.ts")
).href
const postHogScrubbingUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/posthog-scrubbing.ts")
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
const {
  buildKnowledgeSearchUserScopeFilter,
  getAiSdkKnowledgeSearchToolResultMetadata,
} = await import(knowledgeSearchUrl)
const {
  createAiSdkManagedSearchTools,
  getAiSdkManagedSearchToolCallMetadata,
  getAiSdkManagedSearchToolResultMetadata,
} = await import(managedSearchUrl)
const {
  buildUploadedDocumentSearchRecords,
  chunkKnowledgeText,
  extractSimplePdfReadableText,
  extractSimplePdfText,
  indexUploadedDocument,
  normalizeExtractedKnowledgeText,
  normalizeExtractedReadableText,
} = await import(knowledgeIndexingUrl)
const {
  resolveAgentFeatureFlags,
  resolveIntegrationBooleanFlag,
  toEdgeConfigFlagKey,
  toVercelFlagSlug,
} = await import(integrationFlagsUrl)
const { scrubSentryEvent } = await import(sentryScrubbingUrl)
const {
  capturePostHogProductEvent,
  isPostHogAnalyticsEnabled,
  toPostHogSizeBucket,
} = await import(postHogAnalyticsUrl)
const { scrubPostHogEvent, scrubPostHogProperties } = await import(
  postHogScrubbingUrl
)
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

test("knowledge search filter scopes private results to the user", () => {
  const filter = buildKnowledgeSearchUserScopeFilter("user-1", "policies")

  assert.equal(filter.AND.length, 2)
  assert.deepEqual(filter.AND[1], {
    "@metadata.corpus": { equals: "policies" },
  })
  assert(
    JSON.stringify(filter).includes("@metadata.visibility"),
    "Expected public visibility to remain searchable."
  )
})

test("uploaded document indexing builds private user-scoped search records", () => {
  const records = buildUploadedDocumentSearchRecords({
    userId: "user-1",
    documentId: "document-1",
    pathname:
      "users/0a041b9462caa4a31bac3567e0b6e6fd9100787d4d01cf6d1ad9d4731ca8f42f/attachments/document-1/statement.pdf",
    filename: "statement.pdf",
    contentType: "application/pdf",
    sizeBytes: 1200,
    sha256: "a".repeat(64),
    text: "Investment policy statement. EBITDA covenant threshold is 3.5x.",
    asOfDate: "2026-05-09",
  })

  assert.equal(records.length, 1)
  assert.equal(
    records[0].id,
    `uploaded-document:${records[0].metadata.ownerKey}:document-1:chunk:0`
  )
  assert.equal(records[0].content.sourceType, "uploaded_document")
  assert.equal(records[0].metadata.visibility, "private")
  assert.equal(records[0].metadata.corpus, "uploads")
  assert.equal(records[0].metadata.ownerId, "user-1")
  assert.equal(records[0].metadata.userId, "user-1")
  assert.equal(records[0].metadata.documentId, "document-1")
  assert.equal(records[0].metadata.asOfDate, "2026-05-09")
  assert.equal(
    records[0].metadata.artifactUrl,
    "/api/uploads/users/0a041b9462caa4a31bac3567e0b6e6fd9100787d4d01cf6d1ad9d4731ca8f42f/attachments/document-1/statement.pdf"
  )
})

test("knowledge text normalization and chunking cap unsafe document payloads", () => {
  const text = `first\u0000 paragraph\n\n${"middle ".repeat(900)}last`
  const normalized = normalizeExtractedKnowledgeText(text)
  const chunks = chunkKnowledgeText(normalized, {
    chunkChars: 800,
    overlapChars: 80,
    maxChunks: 3,
  })

  assert.equal(normalized.includes("\u0000"), false)
  assert.equal(chunks.length, 3)
  assert(chunks.every((chunk) => chunk.length <= 800))
  assert.match(chunks[0], /^first paragraph/)
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

test("PDF indexing extraction applies knowledge normalization directly", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/knowledge-indexing.ts"),
    "utf8"
  )
  const extractPdfTextSource = source.match(
    /export async function extractPdfText\(buffer: Buffer\): Promise<string> \{[\s\S]*?\n\}/
  )?.[0]

  assert.ok(extractPdfTextSource)
  assert.match(
    extractPdfTextSource,
    /normalizeExtractedKnowledgeText\(await extractRawPdfText\(buffer\)\)/,
    "Expected search indexing to collapse whitespace before applying the indexing text cap."
  )
  assert.doesNotMatch(
    extractPdfTextSource,
    /extractPdfTextForModelInput/,
    "Expected search indexing not to reuse the readable prompt extractor."
  )
})

test("uploaded document indexing accepts PDF parameters and caps parse size", async () => {
  const originalUrl = process.env.UPSTASH_SEARCH_REST_URL
  const originalToken = process.env.UPSTASH_SEARCH_REST_TOKEN
  try {
    delete process.env.UPSTASH_SEARCH_REST_URL
    delete process.env.UPSTASH_SEARCH_REST_TOKEN

    const parameterizedMimeResult = await indexUploadedDocument({
      userId: "user-1",
      documentId: "document-1",
      pathname: "users/user-1/attachments/document-1/statement.bin",
      filename: "statement.bin",
      contentType: "application/pdf; charset=binary",
      sizeBytes: 100,
      sha256: "b".repeat(64),
      buffer: Buffer.from("%PDF-1.4", "latin1"),
    })
    assert.deepEqual(parameterizedMimeResult, {
      indexed: false,
      documentId: "document-1",
      reason: "Upstash Search is not configured.",
    })

    const oversizedResult = await indexUploadedDocument({
      userId: "user-1",
      documentId: "document-large",
      pathname: "users/user-1/attachments/document-large/statement.pdf",
      filename: "statement.pdf",
      contentType: "application/pdf",
      sizeBytes: 26 * 1024 * 1024,
      sha256: "c".repeat(64),
      buffer: Buffer.from("%PDF-1.4", "latin1"),
    })
    assert.deepEqual(oversizedResult, {
      indexed: false,
      documentId: "document-large",
      reason: "PDF too large to parse for indexing.",
    })
  } finally {
    if (originalUrl === undefined) {
      delete process.env.UPSTASH_SEARCH_REST_URL
    } else {
      process.env.UPSTASH_SEARCH_REST_URL = originalUrl
    }

    if (originalToken === undefined) {
      delete process.env.UPSTASH_SEARCH_REST_TOKEN
    } else {
      process.env.UPSTASH_SEARCH_REST_TOKEN = originalToken
    }
  }
})

test("simple PDF fallback extracts uncompressed text operators", () => {
  const pdf = Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 91 >>
stream
BT (Chloei smoke SMOKETEST) Tj [( and governed ) 20 (fallback indexing.)] TJ ET
endstream
endobj
%%EOF`,
    "latin1"
  )

  assert.equal(
    extractSimplePdfText(pdf),
    "Chloei smoke SMOKETEST and governed fallback indexing."
  )
})

test("simple PDF fallback preserves readable layout for model input", () => {
  const pdf = Buffer.from(
    `not-a-valid-pdf
BT
(Title) Tj
(Row 1    Value A\tValue B) Tj
ET`,
    "latin1"
  )

  assert.equal(
    extractSimplePdfReadableText(pdf),
    "Title\nRow 1    Value A\tValue B"
  )
})

test("agent feature flags default off and respect explicit env overrides", async () => {
  const original = process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
    delete process.env.EDGE_CONFIG
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      knowledgeSearchEnabled: false,
      asyncReportsEnabled: false,
      telemetryRecordIo: false,
      financeWorkflowsEnabled: false,
    })

    process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED = "true"
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.knowledgeSearchEnabled, true)
    assert.equal(flags.telemetryRecordIo, false)
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
    } else {
      process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("agent feature flag resolution does not mutate shared defaults", async () => {
  const original = process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.EDGE_CONFIG
    process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED = "true"
    assert.equal(
      (await resolveAgentFeatureFlags()).knowledgeSearchEnabled,
      true
    )

    delete process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
    assert.equal(
      (await resolveAgentFeatureFlags()).knowledgeSearchEnabled,
      false
    )
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
    } else {
      process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED = original
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
    toEdgeConfigFlagKey("agent.knowledge_search.enabled"),
    "agent_knowledge_search_enabled"
  )
  assert.equal(
    toVercelFlagSlug("agent.knowledge_search.enabled"),
    "agent-knowledge-search-enabled"
  )
})

test("agent feature flags can read Vercel/Flags-SDK Edge Config shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      flags: {
        "agent-knowledge-search-enabled": true,
        "agent-async-reports-enabled": true,
        "agent-telemetry-record-io": false,
        "agent-finance-workflows-enabled": true,
      },
    }

    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.knowledgeSearchEnabled, true)
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

test("integration boolean flags can read analytics Edge Config shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      analytics_flags: {
        "analytics.posthog.enabled": true,
      },
    }

    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "analytics.posthog.enabled",
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

test("Sentry scrubbing removes sensitive fields without dropping safe metadata", () => {
  const scrubbed = scrubSentryEvent({
    requestId: "request-1",
    user: {
      email: "person@example.com",
      sessionToken: "secret",
    },
    extra: {
      prompt: "raw prompt",
      modelId: "google/gemini-3.1-pro-preview",
    },
  })

  assert.equal(scrubbed.user.sessionToken, "[Filtered]")
  assert.equal(scrubbed.user.email, "[Filtered]")
  assert.equal(scrubbed.extra.prompt, "[Filtered]")
  assert.equal(scrubbed.extra.modelId, "google/gemini-3.1-pro-preview")
})

test("Sentry scrubbing handles every array element", () => {
  const scrubbed = scrubSentryEvent({
    values: Array.from({ length: 60 }, (_, index) => ({
      index,
      sessionToken: `secret-${String(index)}`,
    })),
  })

  assert.equal(scrubbed.values.length, 60)
  assert.equal(scrubbed.values[59].sessionToken, "[Filtered]")
})

test("PostHog scrubbing removes sensitive product analytics fields", () => {
  const scrubbed = scrubPostHogProperties({
    attachment_count: 1,
    filename: "statement.pdf",
    prompt: "raw prompt",
    business_unit: "wealth",
    "$feature/agent-knowledge-search-enabled": true,
  })

  assert.equal(scrubbed.attachment_count, 1)
  assert.equal(scrubbed.filename, "[Filtered]")
  assert.equal(scrubbed.prompt, "[Filtered]")
  assert.equal("business_unit" in scrubbed, false)
  assert.equal(scrubbed["$feature/agent-knowledge-search-enabled"], true)
})

test("PostHog before-send scrubbing applies the property allowlist", () => {
  const scrubbed = scrubPostHogEvent({
    event: "agent_request_started",
    properties: {
      model_id: "google/gemini-3.1-pro-preview",
      customer_segment: "private-bank",
      email: "person@example.com",
    },
  })

  assert.equal(scrubbed.properties.model_id, "google/gemini-3.1-pro-preview")
  assert.equal("customer_segment" in scrubbed.properties, false)
  assert.equal(scrubbed.properties.email, "[Filtered]")
})

test("PostHog product analytics is gated and emits privacy-safe events", async () => {
  const originalEnabled = process.env.POSTHOG_ANALYTICS_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  const originalInternalEmails = process.env.AGENT_INTERNAL_USER_EMAILS
  const originalInternalDomains = process.env.AGENT_INTERNAL_USER_EMAIL_DOMAINS
  const originalInternalOnly = process.env.POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY
  const originalToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const originalHost = process.env.NEXT_PUBLIC_POSTHOG_HOST
  try {
    delete globalThis[postHogCapturesKey]
    delete process.env.AGENT_INTERNAL_USER_EMAILS
    delete process.env.AGENT_INTERNAL_USER_EMAIL_DOMAINS
    delete process.env.POSTHOG_ANALYTICS_ENABLED
    delete process.env.POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY
    delete process.env.EDGE_CONFIG
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "ph_test"
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com"

    assert.equal(await isPostHogAnalyticsEnabled(), false)
    await capturePostHogProductEvent({
      event: "document_uploaded",
      userId: "user-1",
      properties: {
        filename: "private.pdf",
        size_bucket: toPostHogSizeBucket(120_000),
      },
    })
    assert.equal(globalThis[postHogCapturesKey], undefined)

    process.env.POSTHOG_ANALYTICS_ENABLED = "true"
    assert.equal(
      await isPostHogAnalyticsEnabled({ userEmail: "external@example.com" }),
      false
    )
    await capturePostHogProductEvent({
      event: "agent_request_started",
      userEmail: "external@example.com",
      userId: "user-1",
      properties: {
        model_id: "google/gemini-3.1-pro-preview",
      },
    })
    assert.equal(globalThis[postHogCapturesKey], undefined)

    process.env.AGENT_INTERNAL_USER_EMAILS = "agent@example.com"
    assert.equal(
      await isPostHogAnalyticsEnabled({ userEmail: "agent@example.com" }),
      true
    )
    await capturePostHogProductEvent({
      event: "agent_request_started",
      userEmail: "agent@example.com",
      userId: "user-1",
      featureFlags: {
        knowledgeSearchEnabled: true,
        asyncReportsEnabled: false,
        telemetryRecordIo: false,
        financeWorkflowsEnabled: true,
      },
      properties: {
        model_id: "google/gemini-3.1-pro-preview",
        prompt: "raw prompt",
      },
    })

    const captures = globalThis[postHogCapturesKey]
    assert.equal(captures.length, 1)
    assert.equal(captures[0].token, "ph_test")
    assert.equal(captures[0].options.flushAt, 1)
    assert.equal(captures[0].event.disableGeoip, true)
    assert.equal(captures[0].event.distinctId.startsWith("user:"), true)
    assert.equal(captures[0].event.properties.prompt, "[Filtered]")
    assert.equal(captures[0].event.properties.$process_person_profile, false)
    assert.equal(
      captures[0].event.properties["$feature/agent-knowledge-search-enabled"],
      true
    )
    assert.deepEqual(captures[0].event.properties.$active_feature_flags, [
      "agent-knowledge-search-enabled",
      "agent-finance-workflows-enabled",
      "analytics-posthog-enabled",
    ])
  } finally {
    delete globalThis[postHogCapturesKey]
    if (originalEnabled === undefined) {
      delete process.env.POSTHOG_ANALYTICS_ENABLED
    } else {
      process.env.POSTHOG_ANALYTICS_ENABLED = originalEnabled
    }
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
    if (originalInternalEmails === undefined) {
      delete process.env.AGENT_INTERNAL_USER_EMAILS
    } else {
      process.env.AGENT_INTERNAL_USER_EMAILS = originalInternalEmails
    }
    if (originalInternalDomains === undefined) {
      delete process.env.AGENT_INTERNAL_USER_EMAIL_DOMAINS
    } else {
      process.env.AGENT_INTERNAL_USER_EMAIL_DOMAINS = originalInternalDomains
    }
    if (originalInternalOnly === undefined) {
      delete process.env.POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY
    } else {
      process.env.POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY = originalInternalOnly
    }
    if (originalToken === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = originalToken
    }
    if (originalHost === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_HOST
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_HOST = originalHost
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

test("Inngest inline fallback is explicit and covers report/upload routes", () => {
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
  assert.match(
    readFileSync(path.join(cwd, "src/app/api/uploads/route.ts"), "utf8"),
    /UPLOAD_INLINE_INDEX_FAILED/
  )
  assert.match(
    readFileSync(path.join(cwd, "src/app/api/uploads/route.ts"), "utf8"),
    /UPLOAD_INLINE_INDEX_SKIPPED/
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

test("knowledge search tool result metadata rejects invalid successful output", () => {
  assert.deepEqual(
    getAiSdkKnowledgeSearchToolResultMetadata({
      toolCallId: "call-1",
      toolName: "knowledge_search",
      output: {
        output: {},
      },
    }),
    {
      callId: "call-1",
      toolName: "knowledge_search",
      status: "error",
      sources: [],
      operation: "search",
      provider: "upstash_search",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  )
})

test("managed search tools expose Parallel only when configured and always expose Gateway search", () => {
  assert.deepEqual(Object.keys(createAiSdkManagedSearchTools({})).sort(), [
    "gateway_web_search",
  ])
  assert.deepEqual(
    Object.keys(
      createAiSdkManagedSearchTools({ parallelApiKey: "parallel-key" })
    ).sort(),
    ["gateway_web_search", "parallel_search"]
  )
})

test("managed search metadata labels Parallel and Gateway search sources", () => {
  assert.deepEqual(
    getAiSdkManagedSearchToolCallMetadata({
      toolCallId: "call-parallel",
      toolName: "parallel_search",
      input: {
        objective: "Find current AI funding news",
        search_queries: ["AI funding"],
      },
    }),
    {
      callId: "call-parallel",
      toolName: "parallel_search",
      label: "Searching with Parallel",
      query: "Find current AI funding news",
      operation: "search",
      provider: "parallel",
    }
  )

  assert.deepEqual(
    getAiSdkManagedSearchToolResultMetadata({
      toolCallId: "call-gateway",
      toolName: "gateway_web_search",
      output: {
        searchId: "gateway-1",
        results: [
          {
            title: "Gateway Result",
            url: "https://example.com/gateway",
            excerpt: "Current result",
          },
        ],
      },
    }),
    {
      callId: "call-gateway",
      toolName: "gateway_web_search",
      status: "success",
      sources: [
        {
          id: "gateway_web_search-gateway-1-0",
          url: "https://example.com/gateway",
          title: "Gateway Result",
        },
      ],
      operation: "search",
      provider: "vercel_ai_gateway",
      retryable: false,
    }
  )
})

test("managed search metadata marks provider errors retryable", () => {
  assert.deepEqual(
    getAiSdkManagedSearchToolResultMetadata({
      toolCallId: "call-parallel",
      toolName: "parallel_search",
      output: {
        error: "rate_limit",
        message: "Parallel rate limit exceeded.",
      },
    }),
    {
      callId: "call-parallel",
      toolName: "parallel_search",
      status: "error",
      sources: [],
      operation: "search",
      provider: "parallel",
      errorCode: "rate_limit",
      retryable: true,
    }
  )
})

test("managed search metadata treats explicit errors as failures with empty results", () => {
  assert.deepEqual(
    getAiSdkManagedSearchToolResultMetadata({
      toolCallId: "call-gateway",
      toolName: "gateway_web_search",
      output: {
        error: {
          code: "quota_exceeded",
          message: "Gateway search quota exceeded.",
        },
        results: [],
      },
    }),
    {
      callId: "call-gateway",
      toolName: "gateway_web_search",
      status: "error",
      sources: [],
      operation: "search",
      provider: "vercel_ai_gateway",
      errorCode: "quota_exceeded",
      retryable: true,
    }
  )
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

test("PostHog capture uses public shutdown API", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/posthog-analytics.ts"),
    "utf8"
  )

  assert.match(source, /client\.shutdown\(POSTHOG_CAPTURE_TIMEOUT_MS\)/)
  assert.doesNotMatch(source, /client\._shutdown/)
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
