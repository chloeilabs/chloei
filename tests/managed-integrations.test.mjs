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
const browserResearchUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-browser-research-tools.ts")
).href
const agentAttachmentBlobsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-attachment-blobs.ts")
).href
const knowledgeSearchUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/ai-sdk-knowledge-search-tools.ts")
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

const {
  buildAuthenticatedPrivateBlobDownloadUrl,
  buildPrivateBlobAttachmentPathname,
  isUserOwnedBlobPathname,
  normalizeBlobPathname,
} = await import(privateBlobStorageUrl)
const { hydrateBlobBackedAttachments } = await import(agentAttachmentBlobsUrl)
const { isAllowedBrowserResearchUrl } = await import(browserResearchUrl)
const {
  buildKnowledgeSearchUserScopeFilter,
  getAiSdkKnowledgeSearchToolResultMetadata,
} = await import(knowledgeSearchUrl)
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
const { resolveInngestEnvironmentName, shouldSendInngestEvents } = await import(
  inngestEnvironmentUrl
)

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

test("Browserbase research allowlist blocks internal and off-domain URLs", () => {
  assert.equal(
    isAllowedBrowserResearchUrl({
      startUrl: "https://portal.example.com/reports",
      allowedDomains: ["example.com"],
    }),
    true
  )
  assert.equal(
    isAllowedBrowserResearchUrl({
      startUrl: "https://evil.example.net/reports",
      allowedDomains: ["example.com"],
    }),
    false
  )
  assert.equal(
    isAllowedBrowserResearchUrl({
      startUrl: "http://127.0.0.1:3000/admin",
      allowedDomains: ["127.0.0.1"],
    }),
    false
  )
  assert.equal(
    isAllowedBrowserResearchUrl({
      startUrl: "http://[::1]:3000/admin",
      allowedDomains: ["::1"],
    }),
    false
  )
  assert.equal(
    isAllowedBrowserResearchUrl({
      startUrl: "http://[fd00::1]/admin",
      allowedDomains: ["fd00::1"],
    }),
    false
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

test("agent feature flags default off and respect explicit env overrides", async () => {
  const original = process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.AGENT_KNOWLEDGE_SEARCH_ENABLED
    delete process.env.EDGE_CONFIG
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      knowledgeSearchEnabled: false,
      browserbaseEnabled: false,
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
        "agent-browserbase-enabled": false,
        "agent-async-reports-enabled": true,
        "agent-telemetry-record-io": false,
        "agent-finance-workflows-enabled": true,
      },
    }

    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.knowledgeSearchEnabled, true)
    assert.equal(flags.browserbaseEnabled, false)
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
      modelId: "openai/gpt-5.5",
    },
  })

  assert.equal(scrubbed.user.sessionToken, "[Filtered]")
  assert.equal(scrubbed.user.email, "[Filtered]")
  assert.equal(scrubbed.extra.prompt, "[Filtered]")
  assert.equal(scrubbed.extra.modelId, "openai/gpt-5.5")
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
      model_id: "openai/gpt-5.5",
      customer_segment: "private-bank",
      email: "person@example.com",
    },
  })

  assert.equal(scrubbed.properties.model_id, "openai/gpt-5.5")
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
        model_id: "openai/gpt-5.5",
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
        browserbaseEnabled: false,
        asyncReportsEnabled: false,
        telemetryRecordIo: false,
        financeWorkflowsEnabled: true,
      },
      properties: {
        model_id: "openai/gpt-5.5",
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

test("Browserbase browser research guards every request and final URL", () => {
  const source = readFileSync(
    path.join(cwd, "src/lib/server/llm/ai-sdk-browser-research-tools.ts"),
    "utf8"
  )

  assert.match(source, /context\.route\("\*\*\/\*"/)
  assert.match(source, /BROWSER_RESEARCH_FINAL_URL_NOT_ALLOWED/)
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

  assert.match(source, /readFile\(fullPath\)\.catch\(\(\) => null\)/)
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

test("Braintrust finance eval publisher tolerates missing grade objects", () => {
  const source = readFileSync(
    path.join(cwd, "evals/finance/publish-braintrust-eval.mjs"),
    "utf8"
  )

  assert.match(source, /grade\?\.maxScore/)
  assert.match(source, /normalizedMaxScore > 0/)
  assert.doesNotMatch(source, /grade\.maxScore > 0/)
})

test("Inngest environment resolver uses explicit and branch names", () => {
  assert.equal(
    resolveInngestEnvironmentName({
      INNGEST_ENV: "preview-a",
      VERCEL_GIT_COMMIT_REF: "main",
    }),
    "preview-a"
  )
  assert.equal(
    resolveInngestEnvironmentName({
      VERCEL_GIT_COMMIT_REF: "feature/chloei",
    }),
    "feature/chloei"
  )
  assert.equal(resolveInngestEnvironmentName({}), undefined)
  assert.equal(resolveInngestEnvironmentName({ VERCEL: "1" }), undefined)
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
