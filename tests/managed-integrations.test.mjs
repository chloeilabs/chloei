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

test("Inngest inline fallback covers report/trading/upload routes", () => {
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

test("managed search tools always expose Gateway search", () => {
  assert.deepEqual(Object.keys(createAiSdkManagedSearchTools()), [
    "gateway_web_search",
  ])
})

test("managed search metadata labels Gateway search sources", () => {
  assert.deepEqual(
    getAiSdkManagedSearchToolCallMetadata({
      toolCallId: "call-gateway",
      toolName: "gateway_web_search",
      input: {
        objective: "Find current AI funding news",
        search_queries: ["AI funding"],
      },
    }),
    {
      callId: "call-gateway",
      toolName: "gateway_web_search",
      label: "Searching with AI Gateway",
      query: "Find current AI funding news",
      operation: "search",
      provider: "vercel_ai_gateway",
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
      toolCallId: "call-gateway",
      toolName: "gateway_web_search",
      output: {
        error: "rate_limit",
        message: "AI Gateway rate limit exceeded.",
      },
    }),
    {
      callId: "call-gateway",
      toolName: "gateway_web_search",
      status: "error",
      sources: [],
      operation: "search",
      provider: "vercel_ai_gateway",
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
