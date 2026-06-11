# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev                  # Start dev server on port 3000
pnpm build                # Production build
pnpm start                # Start the production Next.js server

# Database (must run before first request)
pnpm migrate              # Run both auth + app migrations
pnpm auth:migrate         # Better Auth schema only
pnpm app:migrate          # Thread, rate-limit, and job tables only
pnpm threads:migrate      # Alias for pnpm app:migrate

# Quality checks
pnpm lint                 # ESLint (zero warnings allowed)
pnpm lint:fix             # Auto-fix ESLint issues
pnpm typecheck            # next typegen && tsc --noEmit
pnpm format               # Prettier (write)
pnpm format:check         # Prettier (check only)
pnpm bundle:budget        # Check built static JS chunk budgets
pnpm bundle:report        # Report bundle headroom against budgets

# Tests
pnpm test                                        # All tests
pnpm test:smoke                                  # All Playwright smoke tests
pnpm test:smoke:mock                             # Credential-free Playwright smoke
pnpm test:smoke:mock:build                       # Build production app, then run mock smoke
pnpm test:smoke:memory                           # Authenticated Mem0 memory smoke
pnpm mem0:smoke                                  # Direct Mem0 add/search/delete smoke
pnpm mem0:cleanup-smoke                          # Remove authenticated memory smoke artifacts
pnpm inngest:smoke                               # Inngest event delivery smoke
pnpm eval:finance                                # Fixture finance eval baseline
pnpm eval:finance:live                           # Live public-markets finance acceptance suite
pnpm eval:finance:grade                          # Grade finance eval results
node --test tests/agent-route-contract.test.mjs  # Single test file
```

ESLint is configured with `--max-warnings=0`, so any warning is a build failure. Run `pnpm lint` before committing.

## Local / Cursor Cloud setup

Use `README.md` for generic local setup. Cursor Cloud-specific setup lives in `AGENTS.md` and `.cursor/setup.sh`; Cloud agents use native PostgreSQL 16 by default, not a Docker Postgres container.

For Vercel-backed local envs, run `vercel login` first, approve the device-login URL in a browser, confirm `.vercel/project.json` links to the Chloei Labs `chloei` project, then run `vercel env pull .env.local --yes`.

## Architecture

### Request Flow

```
Client (useAgentSession)
  → POST /api/agent (route.ts)
    → Auth check (getRequestSession)
    → Sliding-window rate limit + concurrency slot (rate-limit.ts)
    → Zod validation (parseAgentStreamRequest, incl. runMode + attachments)
    → Blob-backed attachment hydration + image/PDF preprocessing
    → System prompt assembly (buildAgentSystemInstruction)
    → AI Gateway stream via Vercel AI SDK (startGatewayResponseStream)
    → NDJSON chunks → client
      → parseStreamEventLine / applyAgentStreamEvent
        → React state update → render
  → Thread upsert (upsertThreadForUser → PostgreSQL JSONB)
```

**Run modes** (`AGENT_RUN_MODES` in `src/lib/shared/agent/messages.ts`): `chat` (default) and `research`. Research mode forces `RESEARCH_MODEL`, injects the Deep Research prompt block, and uses the larger research tool-step budget.

### Server / Client / Shared Boundary

- `src/lib/server/` — server-only. Never import from client components.
- `src/lib/shared/` — isomorphic. Safe to import anywhere.
- `src/lib/actions/` — Next.js server actions; callable from client.
- `src/components/` — client components and hooks.

Violating this boundary causes Next.js build errors because server modules (pg, better-auth) are not bundled for the browser.

### Streaming Protocol

`/api/agent` returns `Content-Type: application/x-ndjson`. Each line is a JSON-encoded `AgentStreamEvent`. The client reads the stream line-by-line in `readResponseStreamLines` and feeds events through `applyAgentStreamEvent` into an `AgentStreamAccumulator`.

Event types (defined in `src/lib/shared/agent/messages.ts`):

- `text_delta` — incremental assistant text
- `reasoning_delta` — incremental reasoning text; redacted reasoning placeholders are filtered, and `reasoning-privacy.ts` rewrites references to private prompt blocks before display
- `agent_status` — `in_progress` | `completed` | `failed` | `cancelled` | `incomplete`
- `tool_call` — tool invocation start with `callId`, `toolName`, `label`, optional `query`
- `tool_result` — tool invocation result with `callId`, `status: success | error`
- `source` — citation source with `id`, `url`, `title`

Each event also carries optional `interactionId` and `lastEventId` checkpoint fields.

The client-side accumulator (`agent-stream-state.ts`) builds:

- `content` — full assistant text
- `reasoning` — full reasoning text
- `toolInvocations` — list of tool calls and their status
- `activityTimeline` — ordered entries of kinds: `tool`, `search`, `sources`, `reasoning`
- `sources` — deduplicated citation list

### Database Tables

`app-migrate.mjs` creates three app tables (Better Auth tables come from `pnpm auth:migrate`):

- `thread` — messages stored as a JSONB column, one row per thread, keyed on `(userId, id)`. There is no separate messages table. Upserts use `WHERE thread."updatedAt" <= EXCLUDED."updatedAt"` to prevent stale writes from overwriting newer state.
- `agent_rate_limit` — PostgreSQL-backed rate-limit store.
- `agent_job` — background job records: `id, userId, type, status, payload, result, error, idempotencyKey, createdAt, updatedAt`; statuses flow `queued → running → completed | failed`.

`isThreadStoreNotInitializedError` detects Postgres error codes `42P01`/`42703` and returns a 500 with a clear migration message rather than a generic crash.

**Thread API** (`/api/threads`):

- `GET` — list all threads for authenticated user, sorted newest-first (pinned first)
- `PUT` — upsert a thread (body: full `Thread` object)
- `DELETE` — delete a thread by id (body: `{ id }`)

**Thread schema** (from `app-migrate.mjs`):

```sql
CREATE TABLE thread (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id text NOT NULL,
  title text NOT NULL,
  model text,
  "isPinned" boolean NOT NULL DEFAULT false,
  messages jsonb NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  PRIMARY KEY ("userId", id)
);
-- Index: thread_user_updated_at_idx ON ("userId", "updatedAt" DESC)
```

### Background Jobs (Inngest)

Durable background work runs through Inngest (`src/lib/server/inngest/`, served from `POST /api/inngest`, `maxDuration` 800s). Job rows live in the `agent_job` table; status is polled via `GET /api/jobs/[jobId]`.

Event types (`src/lib/server/inngest/functions.ts`):

- `knowledge/document.uploaded` — index an uploaded document into Upstash Search (fired by `/api/uploads`)
- `agent/report.requested` — async deep-research report (fired by `POST /api/jobs/report`, gated by `AGENT_ASYNC_REPORTS_ENABLED`)
- `trading/analysis.requested` — trading desk background analysis (fired by `POST /api/trading-desk/jobs`)
- `ops/inngest.smoke` — health-check event used by `pnpm inngest:smoke`

If `INNGEST_EVENT_KEY` is missing or `INNGEST_INLINE_FALLBACK` is set, jobs run inline in the request instead of being enqueued. Environment resolution (`INNGEST_ENV`, `VERCEL_ENV`, branch envs) lives in `inngest/environment.ts`.

### Attachments & Uploads

- `POST /api/uploads` accepts a multipart `file` (PNG, JPEG, WebP, GIF, PDF; max 4 MB per file, 8 MB per request — `AGENT_ATTACHMENT_MAX_FILE_BYTES` / `AGENT_ATTACHMENT_MAX_TOTAL_BYTES` in `src/lib/shared/agent/attachments.ts`), stores it in private Vercel Blob (`BLOB_READ_WRITE_TOKEN`) under `users/{sha256(userId)}/attachments/...`, and emits a `knowledge/document.uploaded` event.
- `GET /api/uploads/[...pathname]` downloads a blob after verifying pathname ownership.
- Before model invocation, `hydrateBlobBackedAttachments` (`agent-attachment-blobs.ts`) reads blobs back into data URLs.
- Only Gemini 3.1 Pro Preview and Kimi K2.6 accept native image/file parts (`modelSupportsImageInput` / `modelSupportsFileInput` in `models.ts`). For text-only models, `image-vision-preprocessor.ts` describes images and `pdf-attachment-preprocessor.ts` extracts PDF text — both via Gemini 3.1 Pro Preview (`VISION_PREPROCESSOR_MODEL` / `PDF_PREPROCESSOR_MODEL`).

### Knowledge Indexing & Search

`knowledge-indexing.ts` chunks uploaded documents (~3,200 chars/chunk, max 80 chunks) and indexes them into Upstash Search (default index `chloei-knowledge`, configured by `UPSTASH_SEARCH_REST_URL` / `UPSTASH_SEARCH_REST_TOKEN` / `UPSTASH_SEARCH_INDEX`). Records are user-scoped via hashed owner keys. The `knowledge_search` tool (`ai-sdk-knowledge-search-tools.ts`) retrieves them; it is gated by the `agent.knowledge_search.enabled` integration flag.

### Trading Desk

A multi-agent trading analysis system backed by a separate Python FastAPI sidecar (`tradingagents-service/` at the repo root, wrapping TauricResearch/TradingAgents; deployed as its own container). The Next.js app proxies to it server-side so the service URL and shared token stay private.

- `POST /api/trading-desk/analyze` — streams analysis (sidecar SSE → NDJSON), `maxDuration` 800s
- `POST /api/trading-desk/jobs` — background analysis via Inngest (`trading/analysis.requested`), polled through `/api/jobs/[jobId]`
- `GET /api/trading-desk/config` — proxies sidecar roster/depth presets
- UI page at `/trading-desk` (`src/components/trading-desk/`); the chat agent gets a `trading_analysis` tool (`ai-sdk-trading-agents-tools.ts`)

Configured by `TRADINGAGENTS_ENABLED` (default true; routes return 503 when false), `TRADINGAGENTS_SERVICE_URL` (default `http://localhost:8000`), `TRADINGAGENTS_SERVICE_TOKEN` (sent as `X-Service-Token`; required in production), and `TRADINGAGENTS_REQUEST_TIMEOUT_MS` (default 780,000 ms). Server client/config/schemas live in `src/lib/server/trading-agents/`; shared event types in `src/lib/shared/trading-agents/`.

### System Prompt Composition

`buildAgentSystemInstruction` (`src/lib/server/agent-context.ts`) assembles the system prompt per-request from labeled blocks using `--- BEGIN LABEL ---` / `--- END LABEL ---` delimiters:

1. `OPERATING INSTRUCTIONS` — from `DEFAULT_OPERATING_INSTRUCTION` in `src/lib/shared/llm/system-instructions.ts`
2. `RUNTIME DATE CONTEXT` — current UTC timestamp + user/server timezones (from `X-User-Timezone` header)
3. Provider overlay (`PROVIDER OVERLAY: <PROVIDER>`) — provider-specific reasoning guidance for Gemini, Qwen, Kimi, or MiMo
4. Task mode overlay (`TASK MODE OVERLAY: <MODE>`) — mode-specific guidance (see below)
5. `DEEP RESEARCH MODE` — only for explicit Research mode, adding the dedicated comprehensive-answer instruction template
6. `FINANCIAL SERVICES WORKFLOW` — only when a financial-services workflow is detected (see below)
7. `LONG-TERM MEMORY CAPABILITY` — optional block shown only when Mem0 is fully configured, instructing the model that memory writes are available
8. `LONG-TERM MEMORY CONTEXT` — optional Mem0-retrieved user memory, treated as context rather than instructions
9. `IDENTITY AND TONE CONTEXT` — from `DEFAULT_SOUL_FALLBACK_INSTRUCTION` in `src/lib/shared`
10. `AUTH USER CONTEXT` — authenticated user id, name, email

After assembly, `withAiSdkInlineCitationInstruction` appends inline citation rules and optionally FMP tool rules when `FMP_API_KEY` is set.

**Financial services workflows** (`src/lib/server/financial-services-workflows.ts`, `src/lib/shared/llm/financial-services.ts`): detects financial-analyst intent (DCF modeling, filing research, earnings review, comps, pitch materials, …) and injects skill-specific guidance into the prompt. Gated by the `agent.finance_workflows.enabled` integration flag (`AGENT_FINANCE_WORKFLOWS_ENABLED`).

Long-term memory is opt-in through `src/lib/server/long-term-memory.ts`. Chloei calls Mem0 REST before agent runs and commits only the latest text-only user/assistant turn after meaningful completed or incomplete streams. OSS uses `/memories` and `/search`; Platform stores durable memories under `user_id`, keeps Chloei's agent/thread scope in metadata for reliable cross-thread retrieval and cleanup, and has a temporary legacy `app_id` fallback for old memories.

**Task modes** (auto-inferred by `inferPromptTaskMode` from message content patterns):

- `general` — default
- `coding` — code/function/script/debug patterns
- `research` — latest/sources/cite/verify/news patterns
- `high_stakes` — medical/security/legal/financial-safety patterns
- `closed_answer` — multiple-choice/exact-answer patterns
- `instruction_following` — strict output format patterns

### Agent Tools

Multiple tool categories, each only active when the respective API key / flag is configured:

| Tool                 | Key / gate                      | Description                                         |
| -------------------- | ------------------------------- | --------------------------------------------------- |
| `web_search`         | `AI_GATEWAY_API_KEY`            | Anthropic native web search through AI Gateway      |
| `gateway_web_search` | `AI_GATEWAY_API_KEY`            | Managed web search via AI Gateway                   |
| `tavily_search`      | `TAVILY_API_KEY`                | Live web search (advanced depth, up to 8 results)   |
| `tavily_extract`     | `TAVILY_API_KEY`                | Extract content from specific URLs (up to 5 URLs)   |
| `parallel_search`    | `PARALLEL_API_KEY`              | Parallel.com agentic web search (Tavily fallback)   |
| `knowledge_search`   | Upstash keys + integration flag | Search user-uploaded documents (Upstash Search)     |
| `code_execution`     | always on                       | Run sandboxed JS or Python for arithmetic/logic     |
| `finance_data`       | optional provider keys          | Normalized finance data via FMP, SEC, FRED, Yahoo   |
| `sec_filings`        | public SEC endpoints            | SEC/EDGAR filing lookup, fetch, sections, tables    |
| `trading_analysis`   | `TRADINGAGENTS_ENABLED`         | Full trading desk analysis via the sidecar          |
| FMP MCP tools        | `FMP_API_KEY`                   | Legacy finance data via Financial Modeling Prep MCP |

**Code execution** (`src/lib/server/llm/code-execution-tools.ts`):

- Runs in a temp directory, blocked from network/filesystem/subprocess access
- JavaScript: runs via Node.js `--input-type=module --eval`
- Python: runs via `python3 -I -c` (override with `PYTHON3_PATH` env var)
- Allowed Python imports: computation-only (`math`, `collections`, `itertools`, etc.)
- Finance/eval profiles can opt into the curated Python backend with `AGENT_CODE_EXECUTION_BACKEND=finance` or the runtime profile. It allows deterministic analysis libraries such as pandas, numpy, scipy, openpyxl, xlsxwriter, matplotlib, and statsmodels while preserving network/subprocess/host-filesystem blocks.
- Timeout: default 10 s, max 60 s; output capped at 12,000 chars

**Finance data** (`src/lib/server/llm/ai-sdk-finance-data-tools.ts`):

- `finance_data` exposes typed operations for provider status, symbol search, quotes, company profiles, historical prices, financial statements, SEC company facts, FRED series observations, analyst recommendations/price targets, and options chains.
- Provider calls return sanitized source URLs and structured error payloads with retryability metadata.
- Yahoo Finance (via `yahoo-finance2`, no API key; `finance-data/yahoo-provider.ts`) is the default for quotes, historical prices, analyst targets, and options, and the non-US fundamentals fallback when a symbol has no SEC CIK. It is imported lazily, normalizes Yahoo payloads defensively (`validateResult: false`), and is supplementary—SEC/FRED/FMP stay citation-grade. Disable with `AGENT_FINANCE_YAHOO_ENABLED=false` (quotes/prices then fall back to Stooq).
- Finance-analysis runs prefer `finance_data`; chat-default runs keep FMP MCP enabled for migration compatibility.

**SEC filings** (`src/lib/server/llm/ai-sdk-sec-filings-tools.ts`):

- `sec_filings` exposes EDGAR company search, filing search, document fetch, section extraction, table extraction, and targeted retrieval over filing text.
- Finance-analysis runs use `sec_filings` for Vals-style public-company filing tasks and keep `finance_data` for normalized facts/statements.
- Finance answer quality expectations are documented in `docs/finance-research-quality.md`; the live public-markets acceptance tasks are in `evals/finance/tasks/live-public-markets.jsonl`.

**FMP MCP tools** (`src/lib/server/llm/ai-sdk-fmp-mcp-tools.ts`):

- Connects to `https://financialmodelingprep.com/mcp` per request
- Curated subset: `search`, `quote`, `company`, `chart`, `statements`
- Tool definitions are cached in-memory after first discovery

**Max tool steps** per agent run: 12 (overridable via `AGENT_TOOL_MAX_STEPS`). Finance-analysis runs use `AGENT_FINANCE_TOOL_MAX_STEPS` (default: 20); research runs use `AGENT_RESEARCH_TOOL_MAX_STEPS` (default: 20). `agent-runtime-synthesis-gating.ts` nudges synthesis at ~1/3 of the budget and forces a final synthesis step near the cap.

### Follow-Ups & Artifacts

- `POST /api/agent/follow-ups` (`agent-follow-ups.ts`) generates up to 3 contextual follow-up questions after a response, using `openai/gpt-5.1-instant` via AI Gateway.
- `GET /api/agent/artifacts/[artifactId]/[...path]` (`agent-artifacts.ts`) serves files produced by code-execution runs. Artifacts are written under `AGENT_ARTIFACT_ROOT` (default `/tmp/chloei-agent-artifacts`) and can be archived to private Vercel Blob.

### Rate Limiting

Default store is `auto` (PostgreSQL-backed when `DATABASE_URL` is configured; falls back to in-memory otherwise). Override with `AGENT_RATE_LIMIT_STORE=postgres` or `memory`. Two independent controls:

- **Sliding window**: 60 req / 60 s per user (keyed `user:<userId>`)
- **Concurrency slots**: max 4 in-flight requests per user

Both live in `src/lib/server/rate-limit.ts`. All limits are overridable via `AGENT_*` env vars; defaults are in `src/lib/server/agent-runtime-config.ts`. The trading desk routes share the same limiter.

### Model Registry

All available models are defined in `src/lib/shared/llm/models.ts` (`AvailableModels`, `ALL_MODELS`). Current models:

| Key                             | Model ID                        | Display Name           |
| ------------------------------- | ------------------------------- | ---------------------- |
| `ALIBABA_QWEN3_7_MAX`           | `alibaba/qwen3.7-max`           | Qwen 3.7 Max           |
| `GOOGLE_GEMINI_3_1_PRO_PREVIEW` | `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview |
| `MOONSHOTAI_KIMI_K2_6`          | `moonshotai/kimi-k2.6`          | Kimi K2.6              |
| `XIAOMI_MIMO_V2_5_PRO`          | `xiaomi/mimo-v2.5-pro`          | MiMo V2.5 Pro          |

`MODEL_SELECTOR_MODELS` defines the subset shown in the model selector UI (currently Qwen 3.7 Max, Kimi K2.6, and MiMo V2.5 Pro). `RESEARCH_MODEL` is Qwen 3.7 Max, and Research mode also injects the dedicated Deep Research prompt block from `src/lib/shared/llm/system-instructions.ts`. Gemini 3.1 Pro Preview remains in `SUPPORTED_MODELS` for Gateway availability and image/PDF preprocessing, but it is not a standalone chat selector option. Vision/file-input capability is tracked per model (`modelSupportsImageInput`, `modelSupportsFileInput`: Gemini + Kimi only). Adding a model requires updating `AvailableModels`, `ModelInfos`, `SUPPORTED_MODELS`, and optionally `MODEL_SELECTOR_MODELS` in that file. The `/api/models` route reads from this registry (filtered by configured API keys via `getModels()` in `src/lib/actions/api-keys.ts`); the agent validates the requested model against it.

### Authentication

Better Auth handles sessions. `getRequestSession` (`src/lib/server/auth-session.ts`) reads the session from request headers. Routes check `isAuthConfigured()` first — if `DATABASE_URL` / `BETTER_AUTH_SECRET` are missing, the app returns a 503 rather than crashing.

**Middleware** (`src/proxy.ts`, exported as Next.js middleware):

- Matcher: `/`, `/sign-in`, `/sign-up` only — API routes are NOT covered by middleware and enforce auth themselves via `getRequestSession`
- When auth is not configured: allows auth pages, redirects elsewhere to `/sign-in`
- When authenticated: redirects auth pages to home (or `redirect` query param path)
- When not authenticated: redirects to `/sign-in` with the original path in a `redirect` query param

### Integration Flags

`src/lib/server/integration-flags.ts` gates newer capabilities. Resolution precedence: explicit env var → Vercel Edge Config (`agent_flags` / `analytics_flags` / `flags` maps) → internal-user defaults (when `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true`) → built-in defaults (all false).

| Flag                              | Env var                           | Gates                        |
| --------------------------------- | --------------------------------- | ---------------------------- |
| `agent.knowledge_search.enabled`  | `AGENT_KNOWLEDGE_SEARCH_ENABLED`  | `knowledge_search` tool      |
| `agent.async_reports.enabled`     | `AGENT_ASYNC_REPORTS_ENABLED`     | `POST /api/jobs/report`      |
| `agent.finance_workflows.enabled` | `AGENT_FINANCE_WORKFLOWS_ENABLED` | Financial services workflows |
| `agent.telemetry.record_io`       | `AGENT_TELEMETRY_RECORD_IO`       | Raw prompt/output telemetry  |
| `analytics.posthog.enabled`       | `POSTHOG_ANALYTICS_ENABLED`       | Server-side PostHog          |

Internal users are matched via `AGENT_INTERNAL_USER_EMAILS` / `AGENT_INTERNAL_USER_EMAIL_DOMAINS` (comma-separated, case-insensitive).

### Observability & Privacy

- **Logging**: `createLogger(scope)` (`src/lib/logger.ts`) returns `{ info, warn, error }`. In production (`NODE_ENV=production` or `LOG_FORMAT=json`), emits newline-delimited JSON with structured fields (`level`, `message`, `scope`, `timestamp`, plus `requestId`, `errorCode`, `durationMs`, `method`, `model`, `outcome`, `route`, `status`, and Vercel deployment metadata when provided). In development, human-readable `[scope] message` format.
- **Route observability**: all API routes use `createRouteObservation` / `observeRouteResponse` (`src/lib/server/route-observability.ts`) to log every request with duration, outcome, and error codes.
- **Sentry** (`sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts`): enabled by `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`; `sendDefaultPii: false`, traces sampled at 0 by default, replays disabled. Every event passes through `scrubSentryEvent` (`src/lib/shared/sentry-scrubbing.ts`), which redacts secret/prompt/PII-looking fields.
- **PostHog** (`src/lib/server/posthog-analytics.ts`): off by default, internal-users-only by default. Tracks `agent_request_started`, `async_report_requested`, `document_uploaded` with an allowlist-scrubbed property set (`src/lib/shared/posthog-scrubbing.ts`); user IDs are SHA-256 hashed (`src/lib/server/privacy.ts`).
- **Reasoning privacy** (`src/lib/shared/agent/reasoning-privacy.ts`): rewrites references to private prompt blocks (soul.md, system prompt, auth context) in streamed reasoning before display.

## File Structure

```
src/
  app/
    (auth)/             # Sign-in and sign-up pages (route group, no shared layout nav)
    (home)/             # Main app page + /trading-desk page (route group)
    api/
      agent/route.ts    # POST /api/agent — streaming agent endpoint
      agent/follow-ups/ # POST — generate follow-up questions
      agent/artifacts/  # GET — download code-execution artifacts
      auth/[...all]/    # Better Auth catch-all
      inngest/route.ts  # Inngest function handler (background jobs)
      jobs/             # POST /api/jobs/report, GET /api/jobs/[jobId]
      models/route.ts   # GET /api/models — available models for configured keys
      threads/route.ts  # GET/PUT/DELETE /api/threads — thread CRUD
      trading-desk/     # analyze (stream), jobs (async), config (proxy)
      uploads/          # POST upload, GET [...pathname] download
    layout.tsx          # Root layout with fonts, theme, providers
    manifest.ts         # PWA manifest
  components/
    agent/home/         # Core chat UI: use-agent-session, stream state, events
    agent/messages/     # Message rendering (user, assistant, queued)
    agent/markdown/     # Memoized markdown renderer
    agent/prompt-form/  # PromptForm and ModelSelector components
    agent/shared/       # Shared agent UI pieces
    app-sidebar.tsx     # App shell sidebar (threads, nav, user)
    auth/               # Sign-in/up forms, auth shell
    graphics/           # Logo and visual effects
    layout/             # QueryClientProvider, route group layout
    trading-desk/       # Trading desk page: form, pipeline, reports, run hook
    ui/                 # shadcn/ui primitives + ShikiCode
  hooks/
    agent/              # useModels, usePersistentSelectedModel
    use-copy-to-clipboard.ts
    use-mobile.ts
  lib/
    actions/api-keys.ts # getModels() server action
    server/
      agent-artifacts.ts        # Code-execution artifact storage + serving
      agent-attachment-blobs.ts # Hydrate blob-backed attachments into data URLs
      agent-context.ts          # buildAgentSystemInstruction
      agent-follow-ups.ts       # Follow-up question generation
      agent-prompt-steering.ts  # Task mode inference + provider/task overlays
      agent-report-jobs.ts      # Async deep-research report jobs
      agent-route.ts            # parseAgentStreamRequest, createAgentStreamResponse
      agent-runtime-config.ts   # All AGENT_* env var defaults
      api-response.ts           # createApiHeaders, createApiErrorBody/Response
      auth-session.ts           # getRequestSession
      auth.ts                   # isAuthConfigured, createAuthUnavailableResponse
      e2e-test-mode.ts          # E2E test mode detection for mock auth/agent
      financial-services-workflows.ts  # Financial intent detection + prompt skills
      inngest/                  # Inngest client, functions, environment resolution
      integration-flags.ts      # Env/Edge Config/internal-user feature flags
      jobs.ts                   # agent_job table CRUD
      knowledge-indexing.ts     # Chunk + index uploads into Upstash Search
      llm/
        agent-runtime.ts          # Core agent runtime orchestration
        agent-runtime-messages.ts # Agent message preparation and formatting
        agent-runtime-synthesis-gating.ts # Mid-budget nudge + final synthesis forcing
        ai-sdk-finance-data-tools.ts  # Normalized finance_data tool (FMP, SEC, FRED)
        ai-sdk-knowledge-search-tools.ts # knowledge_search (Upstash)
        ai-sdk-managed-search-tools.ts   # gateway_web_search, parallel_search
        ai-sdk-sec-filings-tools.ts   # SEC/EDGAR filing retrieval and extraction
        ai-sdk-fmp-mcp-tools.ts   # FMP MCP client + curated tool wrappers
        ai-sdk-gateway-provider-options.ts # AI Gateway provider options
        ai-sdk-tavily-tools.ts    # Tavily search/extract tools
        ai-sdk-trading-agents-tools.ts # trading_analysis tool
        code-execution-tools.ts   # Sandboxed JS/Python execution
        finance-data/             # Finance data provider internals
        gateway-client.ts         # Undici dispatcher with AI Gateway timeouts
        gateway-responses.ts      # startGatewayResponseStream generator
        image-vision-preprocessor.ts # Image → text description for text-only models
        initial-reasoning-chunk-sanitizer.ts  # Filters redacted reasoning placeholders
        pdf-attachment-preprocessor.ts # PDF text extraction for model input
        system-instruction-augmentations.ts  # Citation + FMP rules appended to prompt
      long-term-memory.ts       # Mem0 retrieval + commit
      postgres.ts               # getDatabase() Kysely instance
      postgres-url.mjs          # normalizePostgresConnectionString
      posthog-analytics.ts      # Server-side PostHog capture (scrubbed)
      privacy.ts                # hashUserId / hashPrivacyValue (SHA-256)
      private-blob-storage.ts   # Private Vercel Blob upload/read + ownership
      rate-limit.ts             # Sliding window + concurrency slot
      route-observability.ts    # createRouteObservation, observeRouteResponse
      thread-payload.ts         # parseStoredThread, parseThreadPayload, Zod schemas
      threads.ts                # listThreadsForUser, getThreadForUser, upsertThreadForUser, deleteThreadForUser
      trading-agents/           # Sidecar config, HTTP client, job runner, schemas
    shared/
      agent/messages.ts   # AgentStreamEvent, Message, ToolInvocation, run modes, tool names
      agent/attachments.ts # Attachment metadata types, MIME + size limits
      agent/reasoning-privacy.ts # Sanitize private context references in reasoning
      agent-request-limits.ts  # Numeric defaults for message/char limits
      llm/models.ts       # AvailableModels, ModelInfos, ALL_MODELS, MODEL_SELECTOR_MODELS
      llm/system-instructions.ts  # DEFAULT_OPERATING_INSTRUCTION, DEFAULT_SOUL_FALLBACK_INSTRUCTION
      llm/financial-services.ts   # Financial services workflow/skill definitions
      posthog-scrubbing.ts  # PostHog property allowlist scrubbing
      sentry-scrubbing.ts   # Sentry event scrubbing
      source-links.ts
      threads.ts          # Thread type, sortThreadsNewestFirst, normalizeThread, deriveThreadTitle
      trading-agents/     # Trading desk event/request types (mirrors sidecar)
      auth.ts             # AuthViewer type
      index.ts            # Re-exports all shared modules
    auth-client.ts        # Better Auth browser client
    auth-redirect.ts      # sanitizeAuthRedirectPath, AUTH_REDIRECT_QUERY_PARAM
    cast.ts               # asRecord, asString, isAbortError
    constants.ts
    http-error.ts         # createHttpError, createHttpErrorFromResponse
    logger.ts             # createLogger
    request-id.ts         # resolveRequestIdFromHeaders, createRequestHeaders
    utils.ts              # cn() class merge utility
  proxy.ts                # Next.js middleware (exported as default + config)
  types/assets.d.ts
docs/
  finance-research-quality.md           # Finance answer quality expectations
  managed-integrations-rollout.md       # Sentry/PostHog/Inngest/Upstash/Neon runbook
  vercel-production-launch-readiness.md # Production deployment checklist
evals/finance/            # Finance eval harness, tasks, grader
tradingagents-service/    # Python FastAPI sidecar for the trading desk
tests/
  *.test.mjs              # Node built-in test runner; no framework
  smoke/                  # Playwright browser smoke tests (*.spec.mjs)
  stubs/                  # Per-module test stubs (imported via register-ts-path-hooks.mjs)
```

## Testing

Tests use Node's built-in test runner (`node --test`) — no Jest, no Vitest. Test files are `.mjs` ES modules.

```bash
pnpm test                                          # All test files
node --test tests/agent-route-contract.test.mjs   # Single file
```

Stubs in `tests/stubs/` mock server-only modules (postgres, auth-session, rate-limit, etc.) so tests run without a database. The `tests/register-ts-path-hooks.mjs` helper wires up `@/` path resolution.

## Key Conventions

**TypeScript**: strict mode + `noUncheckedIndexedAccess`. All array index access must handle `undefined`. Target: ES2022, module resolution: Bundler. Path alias: `@/*` → `src/*`.

**API error shape**: all errors return `{ error: string, errorCode: string }` with `X-Request-Id` and `X-Error-Code` headers. Rate-limit responses also include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`.

**Named exports only** — default exports only appear in Next.js page/layout/route files.

**Import order**: enforced by `eslint-plugin-simple-import-sort`. Run `pnpm lint:fix` to auto-sort.

**Zod v4**: the project uses `zod@^4`. The API surface differs from v3 (e.g., `.strict()` behavior, `z.iso.datetime()` instead of `z.string().datetime()`, error formatting).

**React**: React 19, Next.js 16.2. Client components use `"use client"` directive implicitly via component directory conventions.

**Node**: engine pinned to `24.x`. Package manager: `pnpm@10.32.1`.

## Environment Variables

Required for a working local instance:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AI_GATEWAY_API_KEY=
```

All other variables are optional — the code has safe defaults. See `.env.example` for the full list with inline documentation.

| Variable                                           | Purpose                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AUTH_DATABASE_URL`                                | Separate DB for Better Auth (falls back to `DATABASE_URL`)                                              |
| `TAVILY_API_KEY`                                   | Enables Tavily web search + extract tools                                                               |
| `PARALLEL_API_KEY`                                 | Enables `parallel_search` web search tool                                                               |
| `FMP_API_KEY`                                      | Enables Financial Modeling Prep MCP finance tools                                                       |
| `FRED_API_KEY`                                     | Enables FRED macro/rates lookups through `finance_data`                                                 |
| `SEC_API_USER_AGENT`                               | User agent for SEC public company-facts requests                                                        |
| `AGENT_FINANCE_YAHOO_ENABLED`                      | Enable Yahoo Finance (no key) in `finance_data` (default: true)                                         |
| `BLOB_READ_WRITE_TOKEN`                            | Private Vercel Blob for attachment uploads                                                              |
| `UPSTASH_SEARCH_REST_URL` / `_TOKEN`               | Upstash Search for `knowledge_search` (index: `UPSTASH_SEARCH_INDEX`, default `chloei-knowledge`)       |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`        | Inngest background jobs (with `INNGEST_ENV`, `INNGEST_DEV`, `INNGEST_INLINE_FALLBACK`)                  |
| `TRADINGAGENTS_ENABLED`                            | Trading desk feature gate (default: true)                                                               |
| `TRADINGAGENTS_SERVICE_URL`                        | Trading desk sidecar base URL (default: `http://localhost:8000`)                                        |
| `TRADINGAGENTS_SERVICE_TOKEN`                      | Shared secret sent as `X-Service-Token` (required in production)                                        |
| `TRADINGAGENTS_REQUEST_TIMEOUT_MS`                 | Sidecar request timeout (default: 780,000 ms)                                                           |
| `AGENT_KNOWLEDGE_SEARCH_ENABLED`                   | Integration flag: `knowledge_search` tool (default: false)                                              |
| `AGENT_ASYNC_REPORTS_ENABLED`                      | Integration flag: async report jobs (default: false)                                                    |
| `AGENT_FINANCE_WORKFLOWS_ENABLED`                  | Integration flag: financial services workflows (default: false)                                         |
| `AGENT_TELEMETRY_RECORD_IO`                        | Integration flag: record raw prompts/outputs (default: false)                                           |
| `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS` | Enable flagged capabilities for internal users (default: false)                                         |
| `AGENT_INTERNAL_USER_EMAILS` / `_EMAIL_DOMAINS`    | Internal-user matching for flags and analytics                                                          |
| `MEMORY_PROVIDER`                                  | `disabled` or `mem0` (default: `disabled`)                                                              |
| `MEM0_API_URL`                                     | Mem0 REST API origin (default: `http://localhost:8888`; use `https://api.mem0.ai` for Mem0 Platform)    |
| `MEM0_API_KEY`                                     | Mem0 key; self-hosted OSS uses `X-API-Key`, Mem0 Platform uses `Authorization: Token ...`               |
| `MEMORY_AGENT_ID`                                  | Mem0 agent scope (default: `chloei`; use distinct values per environment)                               |
| `MEMORY_TOP_K`                                     | Number of Mem0 memories to retrieve (default: 6)                                                        |
| `MEMORY_THRESHOLD`                                 | Minimum memory similarity threshold (default: 0.1)                                                      |
| `MEMORY_CONTEXT_MAX_CHARS`                         | Max retrieved memory prompt chars (default: 3,000)                                                      |
| `MEMORY_COMMIT_MAX_CHARS`                          | Max assistant chars eligible for memory commit (default: 12,000)                                        |
| `PYTHON3_PATH`                                     | Override `python3` binary for code execution                                                            |
| `AGENT_MAX_MESSAGES`                               | Max messages per request (default: 50)                                                                  |
| `AGENT_MAX_MESSAGE_CHARS`                          | Max chars per message (default: 12,000)                                                                 |
| `AGENT_MAX_TOTAL_CHARS`                            | Max total conversation chars (default: 48,000)                                                          |
| `AGENT_STREAM_TIMEOUT_MS`                          | Stream timeout (default: 800,000 ms)                                                                    |
| `AGENT_TOOL_MAX_STEPS`                             | Max tool use steps per run (default: 12)                                                                |
| `AGENT_RESEARCH_TOOL_MAX_STEPS`                    | Max tool steps for research runs (default: 20)                                                          |
| `AGENT_FINANCE_TOOL_MAX_STEPS`                     | Max tool steps for finance-analysis runs (default: 20)                                                  |
| `AI_GATEWAY_CLIENT_TIMEOUT_MS`                     | AI Gateway HTTP client timeout (default: 3,600,000 ms)                                                  |
| `AGENT_CODE_EXECUTION_BACKEND`                     | `restricted` or `finance`                                                                               |
| `AGENT_CODE_EXECUTION_PYTHON_VENV_PATH`            | Optional venv/python path for curated finance execution                                                 |
| `AGENT_ARTIFACT_ROOT`                              | Artifact storage root (default: `/tmp/chloei-agent-artifacts`)                                          |
| `AGENT_EVAL_RESULTS_DIR`                           | Output directory for finance eval results/artifacts                                                     |
| `AGENT_RATE_LIMIT_ENABLED`                         | Enable/disable rate limiting (default: true)                                                            |
| `AGENT_RATE_LIMIT_WINDOW_MS`                       | Rate limit window (default: 60,000 ms)                                                                  |
| `AGENT_RATE_LIMIT_MAX_REQUESTS`                    | Max requests per window (default: 60)                                                                   |
| `AGENT_RATE_LIMIT_STORE`                           | `auto`, `memory`, or `postgres` (default: `auto` — uses postgres if `DATABASE_URL` is set, else memory) |
| `AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT`         | Concurrency limit (default: 4)                                                                          |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`            | Enable Sentry error capture (server / client)                                                           |
| `SENTRY_TRACES_SAMPLE_RATE`                        | Sentry trace sampling (default: 0)                                                                      |
| `POSTHOG_ANALYTICS_ENABLED`                        | Server-side PostHog (default: false; internal users only by default)                                    |
| `POSTHOG_PROJECT_API_KEY`                          | PostHog project key (host: `POSTHOG_HOST`)                                                              |
| `LOG_FORMAT`                                       | Set to `json` to force structured JSON logs                                                             |
| `BETTER_AUTH_COOKIE_DOMAIN`                        | Shared cookie domain for cross-subdomain auth                                                           |
| `BETTER_AUTH_TRUSTED_ORIGINS`                      | Comma-separated list of additional trusted origins                                                      |

Vercel tip: `vercel env pull .env.local` is the quickest way to hydrate local development from Vercel project settings.
