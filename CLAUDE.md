# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chloei is a **Next.js 16 / React 19** authenticated AI chat app backed by the **Vercel AI Gateway**. A single streaming agent endpoint (`/api/agent`) runs a multi-step tool-using loop (web search, code execution, finance data, SEC filings, trading analysis) and streams NDJSON to the browser. Auth, sessions, threads, and rate limiting are **PostgreSQL-backed** (Better Auth + Kysely/`pg`).

> **Maintaining this file:** keep it accurate and concise — stale or bloated guidance makes Claude ignore the parts that matter. Cite durable anchors (file paths + symbol names), not line numbers. When you change a subsystem, update the matching section here in the same PR.

## Commands

```bash
# Development
pnpm dev                  # Start dev server on port 3000
pnpm build                # Production build
pnpm start                # Start the production Next.js server

# Database (must run before first request — storage does NOT self-initialize)
pnpm migrate              # Run both auth + app migrations
pnpm auth:migrate         # Better Auth schema only
pnpm app:migrate          # thread + agent_job + agent_rate_limit tables (also drops legacy tables)
pnpm threads:migrate      # Alias for pnpm app:migrate

# Quality checks (run before committing)
pnpm lint                 # ESLint (zero warnings allowed — --max-warnings=0)
pnpm lint:fix             # Auto-fix ESLint issues
pnpm typecheck            # next typegen && tsc --noEmit
pnpm format               # Prettier (write)
pnpm format:check         # Prettier (check only)
pnpm bundle:budget        # Fail if built static JS exceeds budget (14 MiB total / 1 MiB per chunk)
pnpm bundle:report        # Report-only: chunk headroom + per-route first-load JS

# Tests
pnpm test                                        # All unit tests (node --test tests/*.test.mjs)
pnpm test:smoke:mock                            # Credential-free Playwright smoke (needs a prior build)
pnpm test:smoke:mock:build                      # Build production app, then run mock smoke
node --test tests/agent-route-contract.test.mjs  # Single test file

# Finance evals + ops
pnpm eval:finance                               # Fixture finance eval baseline
pnpm eval:finance:live                          # Live public-markets finance acceptance suite
pnpm eval:finance:grade                         # Grade finance eval outputs
pnpm inngest:smoke                              # Send one no-op ops/inngest.smoke event (needs INNGEST_EVENT_KEY)
```

ESLint runs with `--max-warnings=0`, so any warning fails the build. CI also enforces `pnpm format:check`. Run `pnpm lint && pnpm format:check && pnpm typecheck` before committing.

## Local / Cursor Cloud setup

`README.md` covers generic local setup. Cursor Cloud-specific setup lives in `AGENTS.md`, `.cursor/setup.sh`, `.cursor/environment.json`, and `.cursor/Dockerfile`; Cloud agents use native PostgreSQL 16 by default, not Docker. The Claude Code SessionStart hook (`.claude/hooks/session-start.sh`, wired by `.claude/settings.json`) provisions the local database, runs migrations, and installs Playwright Chromium so web sessions can build and test immediately.

For Vercel-backed local envs, run `vercel login`, approve the device-login URL, confirm `.vercel/project.json` links to the Chloei Labs `chloei` project, then `vercel env pull .env.local --yes`.

## Architecture

### Request Flow

```
Client (useAgentSession)
  → POST /api/agent (app/api/agent/route.ts)
    → Auth check (isAuthConfigured → getRequestSession)   [routes self-guard; see Middleware]
    → Sliding-window rate limit (rate-limit.ts, key user:<userId>)
    → Zod validation (parseAgentStreamRequest) — incl. runMode (chat|research) and model
    → Concurrency slot acquire (max 4 in-flight per user)
    → System prompt assembly (buildAgentSystemInstruction)
    → Runtime profile resolution (chat_default | deep_research | finance_analysis | gdpval_workspace)
    → AI Gateway stream via Vercel AI SDK (startGatewayResponseStream → runAgentStream)
    → NDJSON chunks (application/x-ndjson) → client
      → readResponseStreamLines / parseStreamEventLine
        → applyAgentStreamEvent → AgentStreamAccumulator → React state → render
  → Thread upsert (useThreadStore → PUT /api/threads → upsertThreadForUser → PostgreSQL JSONB)
```

Key route files: `src/app/api/agent/route.ts` (HTTP entry, auth, rate limit, validation) → `src/lib/server/agent-route.ts` (`parseAgentStreamRequest`, `createAgentStreamResponse`, NDJSON writing, fallback handling) → `src/lib/server/llm/agent-runtime.ts` (the tool loop) → `src/lib/server/llm/gateway-responses.ts` (`startGatewayResponseStream`).

Before the model sees them, messages pass through the attachment pipeline (`hydrateBlobBackedAttachments` → `preparePdfAttachmentsForModel` → `describeImagesForTextOnlyModel` for text-only models → `toModelMessages`). System-role messages are rejected in `toModelMessages` — system content must come via `systemInstruction`.

### Server / Client / Shared Boundary

- `src/lib/server/` — server-only. Never import from client components.
- `src/lib/shared/` — isomorphic. Safe to import anywhere.
- `src/lib/actions/` — Next.js server actions; callable from client.
- `src/components/` — client components and hooks.

This boundary is **enforced by Next.js bundling at build time** (importing `pg`/`better-auth`/server modules into a client bundle is a build error), **not** by an ESLint rule. Keep it in mind when adding imports.

### Runtime Profiles vs. Task Modes (two independent axes)

These are easy to confuse. They are orthogonal:

- **Runtime profile** (`resolveRuntimeProfile` in `agent-route.ts`, `AGENT_RUNTIME_PROFILES` in `agent-runtime.ts`) — one of `chat_default`, `deep_research`, `finance_analysis`, `gdpval_workspace`. The profile drives the **tool set**, the **code-execution backend** (`finance` for `finance_analysis`/`gdpval_workspace`), the **tool-step budget**, and artifact/workspace behavior. `gdpval_workspace` is eval-only (preserves the code-execution workspace, exposes the artifact directory, accepts `codeExecutionInputFiles`) and is never auto-selected from an HTTP request.
- **Task mode** (`inferPromptTaskMode` in `agent-prompt-steering.ts`) — inferred from message content; drives only the **prompt overlay text** and the Gemini thinking level. Modes: `general`, `coding`, `debugging`, `writing`, `research`, `finance_analysis`, `high_stakes`, `closed_answer`, `instruction_following`.

Research mode is a **request flag** (`runMode: "research"`), not an inference. It selects the `deep_research` profile and `RESEARCH_MODEL` (Qwen 3.7 Max); if that model is unavailable the route returns 400 `AGENT_RESEARCH_MODEL_UNAVAILABLE`.

### System Prompt Composition

`buildAgentSystemInstruction` (`src/lib/server/agent-context.ts`) assembles the prompt per-request from labeled blocks delimited by `--- BEGIN <LABEL> ---` / `--- END <LABEL> ---`, in this order:

1. `OPERATING INSTRUCTIONS` — `DEFAULT_OPERATING_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
2. `RUNTIME DATE CONTEXT` — current UTC timestamp + user timezone (from `X-User-Timezone` header)
3. **Provider overlay** (`PROVIDER OVERLAY: ALIBABA|GOOGLE|MOONSHOTAI|XIAOMI`) — keyed by the model's **provider org**, not its nickname (alibaba=Qwen, google=Gemini, moonshotai=Kimi, xiaomi=MiMo). Always applied for a supported model.
4. **Task mode overlay** (`TASK MODE OVERLAY: <MODE>`)
5. `DEEP RESEARCH MODE` — only for `runMode: "research"`
6. `FINANCIAL SERVICES WORKFLOW` — only when a financial-services workflow resolves (`financeWorkflowsEnabled` flag)
7. `IDENTITY AND TONE CONTEXT` — `DEFAULT_SOUL_FALLBACK_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
8. `AUTH USER CONTEXT` — authenticated user id, name, email

Inline-citation rules and finance tool rules are appended **later**, by `withAiSdkInlineCitationInstruction` (`system-instruction-augmentations.ts`), inside `createAgentStreamResponse` — not by `buildAgentSystemInstruction`.

### Streaming Protocol

`/api/agent` returns `Content-Type: application/x-ndjson`. Each line is a JSON-encoded `AgentStreamEvent` (`src/lib/shared/agent/messages.ts`). The client reads line-by-line in `readResponseStreamLines` and feeds events through `applyAgentStreamEvent` into an `AgentStreamAccumulator`.

Event types:

- `text_delta` — incremental assistant text
- `reasoning_delta` — incremental reasoning text (sanitized + redacted-placeholder-filtered; see below)
- `agent_status` — `in_progress | completed | failed | cancelled | incomplete`
- `tool_call` — tool start: `callId`, `toolName`, `label`, plus optional `query`, `operation`, `provider`
- `tool_result` — tool result: `callId`, `status: success | error`, plus optional `operation`, `provider`, `attempt`, `durationMs`, `errorCode`, `retryable`, `artifactManifest`
- `source` — citation source: `id`, `url`, `title`

Every event also carries optional `interactionId` and `lastEventId` checkpoint fields.

The client accumulator (`agent-stream-state.ts`) builds: `content`, `reasoning`, `toolInvocations`, `activityTimeline` (kinds: `tool`, `search`, `sources`, `reasoning`), and `sources` (deduped by URL).

### Synthesis Gating and Fallbacks

The runtime actively prevents "ran tools but never wrote an answer" outcomes (`agent-runtime.ts` + `agent-runtime-synthesis-gating.ts`):

- **Final-synthesis step** — on the last allowed step (`stepNumber >= toolMaxSteps - 1`), `prepareStep` forces `toolChoice: "none"` and appends an instruction to write the answer in the user's exact terminology.
- **Mid-budget nudge** — from ~1/3 of the step budget onward, appends a reminder to stop retrieving and start synthesizing (disabled when the budget is ≤ 3 steps).
- **Empty-response fallback** — if the main stream ends with zero emitted text (and wasn't aborted), a second `streamText` call with `toolChoice: "none"` forces a written answer. Orphan tool-calls are patched with synthetic stub tool-results (`sanitizeResponseMessagesForFallback`) to avoid `AI_MissingToolResultsError`.

`createAgentStreamResponse` also injects fallback text and downgrades `agent_status` to `incomplete` on timeout, provider-auth errors (401/403/`invalid_api_key` → "Invalid AI_GATEWAY_API_KEY"), or empty output. Responses set `X-Agent-Effective-Model` and `Cache-Control: no-store, no-transform`.

### Reasoning and Privacy

Streamed reasoning is filtered through three layers so the hidden prompt never leaks:

1. Literal `[REDACTED]` reasoning chunks are dropped (`initial-reasoning-chunk-sanitizer.ts`).
2. Leading `thinking:` / `reasoning:` labels are stripped (buffered across chunk boundaries).
3. `sanitizeReasoningForDisplay` (`src/lib/shared/agent/reasoning-privacy.ts`) redacts prompt-internal terms (`soul.md`, "system prompt", "operating instructions", "provider overlay", "task mode overlay", "auth user context", etc.). `getPrivateReasoningCarryLength` holds back a trailing partial token across chunk boundaries so a split secret can't slip through. Applied both at stream time and on thread persistence.

User ids are never written into blob storage paths: `hashUserId` (`src/lib/server/privacy.ts`) produces a `sha256:<hex>` digest used as the storage prefix.

### Agent Tools

Each tool is only registered when its requirements are met, **and** when the active runtime profile enables it. Finance tools (`finance_data`, `sec_filings`) and the finance code-execution backend are enabled for `finance_analysis`/`gdpval_workspace` profiles.

| Tool               | Requirement                                | Tool id / operations                                                                                                                     |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `tavily_search`    | `TAVILY_API_KEY`                           | Web search. `topic: general\|news\|finance`, `timeRange`, `includeDomains`, `excludeDomains`, `country`; up to **8** results (default 5) |
| `tavily_extract`   | `TAVILY_API_KEY`                           | Extract content from up to **5** URLs; `extractDepth: basic\|advanced` (default advanced), `format: markdown\|text`                      |
| `code_execution`   | always on                                  | `language: javascript\|python`; backend resolved from profile / `AGENT_CODE_EXECUTION_BACKEND`                                           |
| `finance_data`     | public Stooq/SEC                           | ops: `provider_status \| symbol_search \| quote \| company_profile \| historical_prices \| financial_statements \| sec_company_facts`    |
| `sec_filings`      | public SEC endpoints                       | ops: `company_search \| filing_search \| document_fetch \| section_extract \| table_extract \| retrieve_information`                     |
| `trading_analysis` | `TRADINGAGENTS_ENABLED` (≠false) + sidecar | `ticker`, `depth`, `analysts[]`; runs the Trading Desk sidecar (1–3 min)                                                                 |

**Code execution** (`src/lib/server/llm/code-execution-tools.ts`):

- Runs in a temp directory; network/filesystem/subprocess access blocked.
- JavaScript: runs via the Node binary (`process.execPath`) with `--input-type=module --eval`.
- Python: runs via `python3 -I -c` (override the binary with `PYTHON3_PATH`).
- **Restricted backend** (default): computation-only Python imports (`math`, `collections`, `itertools`, …).
- **Finance backend** (`AGENT_CODE_EXECUTION_BACKEND=finance`, or the `finance_analysis`/`gdpval_workspace` profile): adds `pandas`, `numpy`, `scipy`, `openpyxl`, `xlsxwriter`, `matplotlib`, `statsmodels`, plus `dateutil`, `mpl_toolkits`, `zipfile`. Network/subprocess stay blocked; file access is restricted to the workspace + temp dir (mounted reference files are readable by relative path). Optional interpreter via `AGENT_CODE_EXECUTION_PYTHON_VENV_PATH`.
- **Limits**: timeout default **10 s**, max **60 s**; code input and output each capped at **12,000 chars**.

**Finance data** (`ai-sdk-finance-data-tools.ts`): quotes + historical prices come from **Stooq** (keyless, delayed); company profiles, statements, company facts, and symbol search come from **SEC/EDGAR**. `provider: auto|sec|stooq`. Source URLs are sanitized (api keys stripped); errors carry `retryable` metadata. Internal fetch: 2 attempts, 12 s timeout. SEC requests use `SEC_API_USER_AGENT`, falling back to a generic UA (surfaced in `provider_status`).

**SEC filings** (`ai-sdk-sec-filings-tools.ts`): EDGAR retrieval/extraction over filing text. Only `https://www.sec.gov/Archives/edgar/data/...` URLs are accepted. Caps: default 25,000 / max 80,000 chars per fetch; default 10 / max 50 results. Pass `accessionNumber` through `document_fetch`/`section_extract`/`table_extract`/`retrieve_information` to stay on the same filing. Quality expectations: `docs/finance-research-quality.md`.

**Artifacts** (`src/lib/server/agent-artifacts.ts`): only the **finance backend with a preserved workspace** emits artifacts. Generated files (≤ 50) are collected into an `artifactManifest` (`{ path, sizeBytes, url? }`), excluding mounted inputs and `__pycache__`. URLs are either private Vercel Blob links or the local authenticated route `/api/agent/artifacts/{artifactId}/{...path}` (path-traversal-safe, per-user scoped, `Content-Disposition: attachment`). Storage root: `AGENT_ARTIFACT_ROOT` (default `<tmpdir>/chloei-agent-artifacts`).

**Max tool steps**: 12 default (`AGENT_TOOL_MAX_STEPS`); 20 for research (`AGENT_RESEARCH_TOOL_MAX_STEPS`) and finance-analysis (`AGENT_FINANCE_TOOL_MAX_STEPS`).

### Model Registry

All models are defined in `src/lib/shared/llm/models.ts`:

| Key                             | Model ID                        | Display Name           |
| ------------------------------- | ------------------------------- | ---------------------- |
| `ALIBABA_QWEN3_7_MAX`           | `alibaba/qwen3.7-max`           | Qwen 3.7 Max           |
| `GOOGLE_GEMINI_3_1_PRO_PREVIEW` | `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview |
| `MOONSHOTAI_KIMI_K2_6`          | `moonshotai/kimi-k2.6`          | Kimi K2.6              |
| `XIAOMI_MIMO_V2_5_PRO`          | `xiaomi/mimo-v2.5-pro`          | MiMo V2.5 Pro          |

- `MODEL_SELECTOR_MODELS` — the chat selector subset: Qwen 3.7 Max, Kimi K2.6, MiMo V2.5 Pro.
- `RESEARCH_MODEL` — Qwen 3.7 Max (Research mode also injects the Deep Research prompt block).
- Gemini stays in `SUPPORTED_MODELS` for Gateway availability and is the **image/PDF preprocessor model** (`VISION_PREPROCESSOR_MODEL` / `PDF_PREPROCESSOR_MODEL`), but it is not a standalone chat selector option.
- Native image + file input is enabled only for Gemini and Kimi (`modelSupportsImageInput` / `modelSupportsFileInput`); other models get text descriptions of attachments instead.
- Adding a model means updating `AvailableModels`, `ModelInfos`, `SUPPORTED_MODELS`, and optionally `MODEL_SELECTOR_MODELS`. `/api/models` filters this registry by configured keys (`getModels()` in `src/lib/actions/api-keys.ts`).

### Thread Storage

Messages are stored as a JSONB column on the `thread` table (one row per thread, keyed `(userId, id)`). There is no separate messages table. Upserts use `WHERE thread."updatedAt" <= EXCLUDED."updatedAt"` to prevent stale writes from overwriting newer state. `isThreadStoreNotInitializedError` detects Postgres `42P01`/`42703` and returns a 500 with a migration message.

**Actual schema** (from `app-migrate.mjs` — note: there is **no `isPinned` column**):

```sql
CREATE TABLE thread (
  "userId"    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id          text NOT NULL,
  title       text NOT NULL DEFAULT 'New Conversation',
  model       text,
  messages    jsonb NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  PRIMARY KEY ("userId", id)
);
-- Index: thread_user_updated_at_idx ON ("userId", "updatedAt" DESC)
```

`app-migrate.mjs` also creates `agent_rate_limit` and `agent_job` (below), backfills `title`, and drops legacy tables/columns.

**Pinning is client-side only** — there is no server column. Pinned thread ids live in `localStorage` (`chloei:pinned-thread-ids`, `src/components/nav-threads.tsx`) and pinned-first ordering happens in the sidebar render, not in the API.

**Thread API** (`/api/threads`):

- `GET` (no query) — returns lightweight `ThreadSummary[]` (id, title, model, timestamps; **no messages**), newest-first.
- `GET ?id=<threadId>` — returns the full `Thread` (with messages).
- `PUT` — upsert a full `Thread`.
- `DELETE` — delete by id (body `{ id }`); responds `204 No Content`.

**Client thread store** (`src/components/agent/home/use-thread-store.ts` via `ThreadStoreProvider`) — a bespoke `useState`/refs store (not React Query). It holds `threadSummaries` (the list), lazily-hydrated full `threads`, and `currentThreadId`. Writes go through `saveThread`: optimistic local merge, then an immediate or 800 ms-debounced `PUT`, with 3 s retry, per-thread `AbortController` dedupe, and `updatedAt` stale-write protection. Only `/api/models` uses React Query.

### Rate Limiting

Default store is `auto` (PostgreSQL-backed when `DATABASE_URL` is set; in-memory otherwise). Override with `AGENT_RATE_LIMIT_STORE=postgres|memory`. Two independent agent controls (`src/lib/server/rate-limit.ts`):

- **Sliding window**: 60 req / 60 s per user (key `user:<userId>`).
- **Concurrency slots**: max 4 in-flight requests per user.

Persistent state lives in the `agent_rate_limit` table (`identifier` PK, `hits` jsonb, `inFlight`, `lastSeenAt`); stale rows are cleaned opportunistically; the store fails open to memory on DB error. All limits are overridable via `AGENT_*` env vars (`src/lib/server/agent-runtime-config.ts`).

Separately, **Better Auth has its own credential-route limits** (`auth.ts`): ~100 req / 10 s globally, with `/sign-in/email` and `/sign-up/email` capped at 5 req / 15 min. This is independent of the agent limiter.

### Authentication and Middleware

Better Auth handles sessions. `getRequestSession` (`src/lib/server/auth-session.ts`) reads the session from request headers. `isAuthConfigured()` returns false when `DATABASE_URL`/`BETTER_AUTH_SECRET` are missing — routes then return 503 rather than crashing. On Vercel, `BETTER_AUTH_URL` can be inferred from `VERCEL_URL`/`VERCEL_BRANCH_URL`/`VERCEL_PROJECT_PRODUCTION_URL`, so `isAuthConfigured()` can be true without an explicit `BETTER_AUTH_URL`.

**Middleware** (`src/proxy.ts`) — exported as a **named** `proxy` function plus `config` (not a default export):

- **Matcher is only `["/", "/sign-in", "/sign-up"]`.** It does **not** match `/api/*`. API routes are guarded by their own in-route `isAuthConfigured()` / `getRequestSession()` checks, not by middleware.
- `/api/auth/*` and `/api/inngest` are passed through unconditionally (when matched).
- Auth not configured → allow auth pages, 503 on API, redirect elsewhere to `/sign-in`.
- Authenticated → redirect auth pages home (or the `redirect` query path).
- Not authenticated → redirect to `/sign-in`.
- **Fail-open**: if `getRequestSession` throws, the middleware logs and calls `next()` (lets the request through).

### Attachments (Vercel Blob + IndexedDB)

Image and PDF attachments use a two-tier client flow plus private server storage:

- **Upload**: on submit, files are read as data URLs and best-effort uploaded to private Blob via `POST /api/uploads` (`src/lib/server/private-blob-storage.ts`). On upload failure they fall back to an inline `dataUrl`. Blob objects are `access: private`, tenant-isolated under `users/<sha256(userId)>/…`; downloads go only through the authenticated route `/api/uploads/<segments>`.
- **Client persistence**: per-message attachment payloads are stored in **IndexedDB** (`chloei-attachments`, keyed by `(threadId, messageId, attachmentId)`), hydrated on thread open and pruned to surviving messages.
- **Model preparation**: `hydrateBlobBackedAttachments` fetches blob bytes at run time; PDFs are text-extracted (`pdf-text-extraction.ts`); images on text-only models are described via the Gemini vision preprocessor.

### Async Jobs (Inngest)

`src/lib/server/inngest/` + `src/lib/server/jobs.ts` (the `agent_job` table) back Trading Desk runs and async report generation. Served at `/api/inngest`; status via `/api/jobs/[jobId]`; report enqueue via `/api/jobs/report`.

```sql
CREATE TABLE agent_job (
  id               text PRIMARY KEY,
  "userId"         text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  type text, status text,
  payload jsonb DEFAULT '{}', result jsonb, error text,
  "idempotencyKey" text NOT NULL,
  "createdAt"/"updatedAt" timestamp(3),
  UNIQUE ("userId", "idempotencyKey")
);
```

- Job types: `agent/report.requested`, `market/watchlist.refresh.requested`, `trading/analysis.requested`. Statuses: `queued|running|completed|failed`.
- `createAgentJob` is idempotent via `ON CONFLICT ("userId","idempotencyKey")`. `/api/jobs/report` accepts an optional client-generated `reportId` UUID; the idempotency key is `report:<userId>:<threadId|adhoc>:<reportId>`. Idempotency keys must derive from user/document/report/thread ids — **never** from prompt text or document contents.
- **Inline fallback**: Trading Desk runs inline when Inngest is unconfigured **or** `INNGEST_INLINE_FALLBACK` is set; report jobs inline **only** when `INNGEST_INLINE_FALLBACK=1|true`.
- **Async report generation is currently a placeholder** (`completeReportPlaceholderJob` returns a stub result); it is not yet wired to the agent runtime.

### Feature Flags

`src/lib/server/integration-flags.ts` resolves three default-off flags: `asyncReportsEnabled`, `telemetryRecordIo`, `financeWorkflowsEnabled`. Precedence:

1. Explicit `AGENT_*` env vars (`AGENT_ASYNC_REPORTS_ENABLED`, `AGENT_TELEMETRY_RECORD_IO`, `AGENT_FINANCE_WORKFLOWS_ENABLED`).
2. Edge Config (`EDGE_CONFIG`) — checked across three map namespaces in order: **`agent_flags`, `analytics_flags`, `flags`**, matching dotted keys (`agent.async_reports.enabled`, `agent.telemetry.record_io`, `agent.finance_workflows.enabled`) or their Vercel slug form (`agent-async-reports-enabled`, …), then top-level fallback keys.
3. Internal-user defaults — when `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true`, `asyncReportsEnabled` + `financeWorkflowsEnabled` turn on for users in `AGENT_INTERNAL_USER_EMAILS` / `AGENT_INTERNAL_USER_EMAIL_DOMAINS` (telemetry IO is **not** flipped by this).
4. Built-in defaults (off).

### Observability and Telemetry

- **Logging**: `createLogger(scope)` (`src/lib/logger.ts`) returns `{ info, warn, error }`. In production (`NODE_ENV=production` or `LOG_FORMAT=json`) it emits newline-delimited JSON with structured fields (always `level`, `message`, `scope`, `timestamp`; when present `requestId`, `errorCode`, `durationMs`, `method`, `model`, `outcome`, `route`, `status`, plus Vercel deployment metadata). In dev it falls back to human-readable `[scope] message`.
- **Route observability**: all API routes use `createRouteObservation` / `observeRouteResponse` (`src/lib/server/route-observability.ts`) to log duration, outcome, and error codes.
- **Product analytics**: `@vercel/analytics` and `@vercel/speed-insights` are mounted in the root layout (`src/app/layout.tsx`).
- **There is no Sentry, PostHog, or OpenTelemetry** — those integrations were removed. Error tracking is via Vercel runtime logs (the structured JSON above). Do not reintroduce them without an explicit decision.

### Integrations

- **Trading Desk** (`/trading-desk`; `src/components/trading-desk/`, `src/app/api/trading-desk/`, `src/lib/server/trading-agents/`) — proxies an external Python "TradingAgents" FastAPI sidecar (`TRADINGAGENTS_SERVICE_URL`, default `http://localhost:8000`; enabled unless `TRADINGAGENTS_ENABLED=false`) for multi-agent equity analysis. Runs as an async job (or live NDJSON stream) and is also exposed to chat via the `trading_analysis` tool. The page enqueues `POST /api/trading-desk/jobs` and polls `GET /api/jobs/{id}` every 2.5 s (survives dropped connections). Sidecar docs: `tradingagents-service/README.md`.
- **File attachments / async jobs / feature flags** — see the dedicated sections above.

## File Structure

```
src/
  app/
    (auth)/             # Sign-in / sign-up pages (route group)
    (home)/             # Main app — wraps children in ThreadStoreProvider
      page.tsx          #   server component: auth-guards, getModels(), seeds RQ cache
      trading-desk/     #   Trading Desk page (shares the (home) sidebar + thread store)
    api/
      agent/route.ts       # POST /api/agent — streaming agent endpoint
      agent/follow-ups/    # Follow-up question suggestions
      agent/artifacts/     # Authenticated code-execution artifact downloads
      auth/[...all]/       # Better Auth catch-all
      inngest/route.ts     # Inngest function endpoint (async jobs)
      jobs/[jobId]/        # Async job status
      jobs/report/         # Async report enqueue (placeholder runtime)
      models/route.ts      # GET /api/models — available models for configured keys
      threads/route.ts     # GET/PUT/DELETE /api/threads — thread CRUD
      trading-desk/        # analyze (stream), jobs (async), config
      uploads/             # Private Blob attachment upload + download
    layout.tsx          # Root layout: fonts, dark theme, Analytics + SpeedInsights, dev cache-reset
    manifest.ts         # PWA manifest (production-only standalone)
  components/
    agent/home/         # Chat core: use-agent-session, agent-stream-state/-events,
                        #   thread-store-context, use-thread-store, home-content,
                        #   agent-attachment-store (IndexedDB), follow-up-questions
    agent/messages/     # Message rendering (user, assistant, queued, activity timeline)
    agent/markdown/     # Memoized markdown renderer
    agent/prompt-form/  # PromptForm (inline Research + Tools popover), ModelSelector, attachments
    app-sidebar.tsx     # Sidebar shell (lazy-loads SearchChats + NavThreads)
    nav-threads.tsx     # Thread list + client-side pinning (localStorage)
    nav-user.tsx        # Account menu + sign-out
    search-chats.tsx    # Client-side thread title search dialog
    trading-desk/       # Trading Desk UI + use-trading-desk-run
    auth/               # Sign-in/up forms, auth shell
    graphics/           # Logo + visual effects
    layout/             # QueryClientProvider, route group layout
    ui/                 # shadcn/ui primitives (base-lyra/stone) + ShikiCode
  hooks/
    agent/              # use-models (React Query), use-persistent-selected-model,
                        #   use-persistent-run-mode (both localStorage-backed)
  lib/
    actions/api-keys.ts # getModels() server action
    brand/colors.ts     # App brand colors (used by layout/manifest)
    editor/highlighter.ts
    server/
      agent-context.ts          # buildAgentSystemInstruction
      agent-prompt-steering.ts  # Task-mode inference + provider/task overlays
      agent-route.ts            # parseAgentStreamRequest, createAgentStreamResponse
      agent-runtime-config.ts   # All AGENT_* env var defaults
      agent-artifacts.ts        # Artifact storage root + download URL helpers
      agent-attachment-blobs.ts # Blob-backed attachment hydration
      agent-report-jobs.ts      # Async report job completion (placeholder)
      auth.ts / auth-session.ts # isAuthConfigured, getRequestSession
      integration-flags.ts      # Default-off feature flags (env + Edge Config)
      jobs.ts                   # agent_job table helpers
      privacy.ts                # hashUserId (blob path prefixes)
      rate-limit.ts             # Sliding window + concurrency slot
      route-observability.ts    # createRouteObservation, observeRouteResponse
      threads.ts / thread-payload.ts  # Thread CRUD + Zod parsing
      postgres.ts               # getDatabase() Kysely instance
      inngest/                  # Inngest client + functions + environment resolution
      trading-agents/           # Trading Desk sidecar client, config, jobs
      llm/
        agent-runtime.ts                  # Core tool-loop orchestration
        agent-runtime-messages.ts         # Message preparation (rejects system-role)
        agent-runtime-synthesis-gating.ts # Final-step + mid-budget synthesis predicates
        gateway-responses.ts              # startGatewayResponseStream
        gateway-client.ts                 # undici dispatcher for AI Gateway
        ai-sdk-gateway-provider-options.ts # Per-model provider options (Gemini thinking)
        ai-sdk-finance-data-tools.ts      # finance_data tool (Stooq, SEC)
        ai-sdk-sec-filings-tools.ts       # sec_filings tool (EDGAR)
        ai-sdk-tavily-tools.ts            # tavily_search / tavily_extract
        ai-sdk-trading-agents-tools.ts    # trading_analysis tool (sidecar)
        code-execution-tools.ts           # Sandboxed JS/Python execution + artifacts
        finance-data/                     # Provider internals (stooq, sec, normalizers, retry, sources)
        image-vision-preprocessor.ts      # Image → text via Gateway vision
        pdf-attachment-preprocessor.ts    # PDF → text for the model
        initial-reasoning-chunk-sanitizer.ts # Redacted-reasoning filtering
        system-instruction-augmentations.ts  # Citation + finance rules appended to prompt
    shared/
      agent/messages.ts          # AgentStreamEvent, Message, ToolInvocation, run modes/statuses
      agent/attachments.ts       # Attachment metadata types
      agent/reasoning-privacy.ts # sanitizeReasoningForDisplay
      agent-request-limits.ts    # Message/char limit defaults
      llm/models.ts              # AvailableModels, ModelInfos, SUPPORTED/SELECTOR/RESEARCH
      llm/system-instructions.ts # DEFAULT_OPERATING_INSTRUCTION, DEFAULT_SOUL_FALLBACK_INSTRUCTION
      llm/financial-services.ts  # Financial-services workflow data
      threads.ts                 # Thread type, sort/normalize/deriveThreadTitle
      trading-agents/types.ts    # Shared Trading Desk types
  proxy.ts                # Next.js middleware (named export `proxy` + `config`)
tests/
  *.test.mjs              # ~50 Node built-in test-runner files (no Jest/Vitest)
  smoke/                  # Playwright specs (mock + live authenticated chat)
  stubs/                  # Per-module server stubs (via register-ts-path-hooks.mjs)
```

## Testing

Tests use Node's built-in runner (`node --test`) — no Jest, no Vitest. Test files are `.mjs` ES modules.

```bash
pnpm test                                          # ~50 unit test files (tests/*.test.mjs)
node --test tests/agent-route-contract.test.mjs    # Single file
```

- `pnpm test` runs **unit tests only** — the Playwright `*.spec.mjs` files under `tests/smoke/` run via `test:smoke*` scripts.
- Stubs in `tests/stubs/` mock server-only modules (postgres, auth-session, rate-limit, …) so tests run without a database.
- `tests/register-ts-path-hooks.mjs` wires `@/` path resolution and supports per-test module stub injection (`setTestModuleStubs`).
- Smoke: `tests/smoke/mock-authenticated-chat.spec.mjs` is credential-free (used by CI); `authenticated-chat.spec.mjs` needs `SMOKE_EMAIL`/`SMOKE_PASSWORD`.

## Key Conventions

**TypeScript**: strict mode + `noUncheckedIndexedAccess` (every array index access must handle `undefined`). Target ES2022, module resolution Bundler. Path alias `@/*` → `src/*`.

**Named exports only** — default exports are allowed only in `src/app/**` (Next.js page/layout/route files) and `src/types/assets.d.ts`. Enforced via an ESLint `no-restricted-syntax` rule on `ExportDefaultDeclaration`.

**ESLint** (type-checked configs on `src/**` + `auth.ts`): beyond `simple-import-sort`, notable error-level rules include `no-console` (warn/error allowed), `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, and `consistent-type-imports` (inline `import type`). `reportUnusedDisableDirectives` is on. Run `pnpm lint:fix` to auto-sort imports.

**Prettier**: `semi: false`, double quotes, `tabWidth: 2`, `printWidth: 80`, `trailingComma: es5`. Only `prettier-plugin-tailwindcss` is configured (`tailwindFunctions: ["cn", "cva"]`); import sorting is ESLint's job, not Prettier's.

**API error shape**: all errors return `{ error, errorCode }` with `X-Request-Id` and `X-Error-Code` headers. Rate-limit responses add `X-RateLimit-*` and `Retry-After`.

**Zod v4** (`zod@^4`): API differs from v3 (`.strict()` behavior, `z.iso.datetime()`, error formatting).

**Stack**: React 19, Next.js 16.2.6, Node `24.x`, pnpm `10.32.1`. Client components use `"use client"` by directory convention. UI is shadcn/ui (`base-lyra` style, `stone` base color, lucide icons; see `components.json`).

**Bundle budget**: `pnpm bundle:budget` fails if total `.next/static` JS exceeds 14 MiB or any single chunk exceeds 1 MiB (overridable via `BUNDLE_MAX_STATIC_CHUNKS_BYTES` / `BUNDLE_MAX_STATIC_CHUNK_BYTES`). CI runs both `bundle:budget` and `bundle:report`.

**Security headers**: a strict CSP and full security-header set (`X-Frame-Options: DENY`, HSTS preload, COOP, Permissions-Policy, `poweredByHeader: false`) are configured in `next.config.mjs`; CSP + HSTS apply in production only.

**CI** (`.github/workflows/ci.yml`): a `checks` job (lint → format:check → test → typecheck → build → bundle:budget → bundle:report), a separate `smoke` job in the Playwright image, and a `vercel-status` job that aggregates both into a single `Vercel` commit status. Vercel build runs `pnpm migrate && pnpm build`; `scripts/vercel-ignore-build.mjs` skips builds for docs/tooling-only diffs.

## Environment Variables

Required for a working local instance:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AI_GATEWAY_API_KEY=
```

All others are optional with safe defaults. See `.env.example` for the full annotated list.

| Variable                                                 | Purpose                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AUTH_DATABASE_URL`                                      | Separate DB for Better Auth (falls back to / reuses `DATABASE_URL`)          |
| `BETTER_AUTH_TRUSTED_ORIGINS`                            | Comma-separated additional trusted origins                                   |
| `BETTER_AUTH_COOKIE_DOMAIN`                              | Shared cookie domain for cross-subdomain auth                                |
| `TAVILY_API_KEY`                                         | Enables `tavily_search` + `tavily_extract`                                   |
| `SEC_API_USER_AGENT`                                     | User agent for SEC requests (falls back to a generic UA)                     |
| `BLOB_READ_WRITE_TOKEN`                                  | Private Vercel Blob store for attachments + artifacts                        |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`              | Enable Inngest async jobs                                                    |
| `INNGEST_ENV` / `INNGEST_DEV`                            | Inngest environment selection / dev mode                                     |
| `INNGEST_INLINE_FALLBACK`                                | `1`/`true` runs jobs inline without Inngest (required to inline report jobs) |
| `EDGE_CONFIG`                                            | Vercel Edge Config connection for remote feature flags                       |
| `TRADINGAGENTS_SERVICE_URL`                              | Trading Desk sidecar base URL (default `http://localhost:8000`)              |
| `TRADINGAGENTS_SERVICE_TOKEN`                            | Shared secret sent to the sidecar (`X-Service-Token`)                        |
| `TRADINGAGENTS_ENABLED`                                  | Enable/disable the Trading Desk (default true)                               |
| `TRADINGAGENTS_REQUEST_TIMEOUT_MS`                       | Upstream sidecar request timeout (default 600,000)                           |
| `AGENT_ASYNC_REPORTS_ENABLED`                            | Feature flag: async report jobs (default off)                                |
| `AGENT_FINANCE_WORKFLOWS_ENABLED`                        | Feature flag: financial-services workflows (default off)                     |
| `AGENT_TELEMETRY_RECORD_IO`                              | Feature flag: record prompt/output IO in telemetry (default off)             |
| `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS`       | Turn on internal-user flag defaults                                          |
| `AGENT_INTERNAL_USER_EMAILS` / `..._EMAIL_DOMAINS`       | Internal-user allowlists for flag defaults                                   |
| `PYTHON3_PATH`                                           | Override `python3` for code execution                                        |
| `AGENT_CODE_EXECUTION_BACKEND`                           | `restricted` (default) or `finance`                                          |
| `AGENT_CODE_EXECUTION_PYTHON_VENV_PATH`                  | Optional venv/python for the finance backend                                 |
| `AGENT_ARTIFACT_ROOT`                                    | Artifact storage root (default `<tmpdir>/chloei-agent-artifacts`)            |
| `AGENT_EVAL_RESULTS_DIR`                                 | Output dir for finance eval results/artifacts                                |
| `AGENT_MAX_MESSAGES` / `_MESSAGE_CHARS` / `_TOTAL_CHARS` | Request size limits (50 / 12,000 / 48,000)                                   |
| `AGENT_STREAM_TIMEOUT_MS`                                | Stream timeout (default 800,000)                                             |
| `AGENT_TOOL_MAX_STEPS`                                   | Max tool steps per run (default 12)                                          |
| `AGENT_RESEARCH_TOOL_MAX_STEPS`                          | Max tool steps for research runs (default 20)                                |
| `AGENT_FINANCE_TOOL_MAX_STEPS`                           | Max tool steps for finance-analysis runs (default 20)                        |
| `AI_GATEWAY_CLIENT_TIMEOUT_MS`                           | AI Gateway HTTP client timeout (default 3,600,000)                           |
| `AGENT_RATE_LIMIT_ENABLED`                               | Enable/disable rate limiting (default true)                                  |
| `AGENT_RATE_LIMIT_WINDOW_MS` / `_MAX_REQUESTS`           | Sliding window (default 60,000 ms / 60)                                      |
| `AGENT_RATE_LIMIT_STORE`                                 | `auto` (default), `memory`, or `postgres`                                    |
| `AGENT_MAX_CONCURRENT_REQUESTS_PER_CLIENT`               | Concurrency limit (default 4)                                                |
| `NEXT_SERVER_ACTIONS_BODY_SIZE_LIMIT`                    | Server actions body limit (default `1mb`)                                    |
| `NEXT_PROXY_CLIENT_MAX_BODY_SIZE`                        | Proxy client max body size (default `12mb`)                                  |
| `LOG_FORMAT`                                             | Set to `json` to force structured logs in dev                                |

## Gotchas

- **Run `pnpm migrate` before the first request.** Storage does not self-initialize on live requests; uninitialized tables surface as a 500 with a migration message.
- **`pnpm test` is unit-only.** Smoke tests need a prior production build (`pnpm test:smoke:mock:build`).
- The **mock smoke test uses the production server** (`next start`), so build first.
- `pnpm.onlyBuiltDependencies` already approves the `sharp` build script — do not run `pnpm approve-builds`.
- Don't reintroduce Sentry/PostHog/OpenTelemetry; they were intentionally removed in favor of Vercel Analytics/Speed Insights + structured logs.
- Pinning, selected model, and run mode are **client-side localStorage** — there are no server columns or APIs for them.
- After signing up via `/api/auth/sign-up/email`, the session cookie is set automatically; no separate sign-in is needed.
