# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chloei is a **Next.js 16 / React 19** authenticated AI chat app backed by the **OpenAI Agents SDK** (`@openai/agents`) running against the **OpenAI API**. A single streaming agent endpoint (`/api/agent`) runs a multi-step tool-using loop (Exa web search) and streams NDJSON to the browser. Auth, sessions, and threads are **PostgreSQL-backed** (Better Auth + Kysely/`pg`).

> **Maintaining this file:** keep it accurate and concise — stale or bloated guidance makes Claude ignore the parts that matter. Cite durable anchors (file paths + symbol names), not line numbers. When you change a subsystem, update the matching section here in the same PR.

## Working Principles

Behavioral guidelines for changes in this repo (adapted from Karpathy's coding principles). They bias toward caution over speed — use judgment on trivial edits. Merge with the project specifics below.

1. **Think before coding.** State assumptions before implementing; if multiple interpretations exist, surface them instead of choosing silently. If something is unclear, stop and ask. Push back when a simpler approach exists.
2. **Simplicity first.** Write the minimum code that solves the problem — no speculative abstractions, configurability, or error handling for impossible cases. Match the small, single-purpose module style already here (`src/lib/server/*`, `src/lib/shared/*`). If 200 lines could be 50, rewrite.
3. **Surgical changes.** Touch only what the request needs. Don't reformat or "improve" adjacent code — Prettier and ESLint (`simple-import-sort`) own formatting and import order, so let them. Match existing conventions (the `@base-ui/react` UI primitives in `src/components/ui`, named exports, Zod v4). Only remove imports/vars your change orphaned; flag unrelated dead code rather than deleting it.
4. **Goal-driven execution.** Turn tasks into verifiable goals: reproduce a bug with a `node --test` file under `tests/`, then make it pass. Verify with `pnpm lint && pnpm typecheck && pnpm test` (add `pnpm build` for RSC, route, or error-boundary changes) and loop until green. For multi-step work, state a brief step → verify plan first.

**These are working if:** fewer unnecessary changes in diffs, fewer rewrites from overcomplication, and clarifying questions arrive before implementation rather than after mistakes.

## Commands

```bash
# Development
pnpm dev                  # Start dev server on port 3000
pnpm build                # Production build
pnpm start                # Start the production Next.js server

# Database (must run before first request — storage does NOT self-initialize)
pnpm migrate              # Run both auth + app migrations
pnpm auth:migrate         # Better Auth schema only
pnpm app:migrate          # thread table (also drops legacy tables)
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
```

ESLint runs with `--max-warnings=0`, so any warning fails the build. CI also enforces `pnpm format:check`. Run `pnpm lint && pnpm format:check && pnpm typecheck` before committing.

## Local / Claude Code setup

`README.md` covers generic local setup. The Claude Code SessionStart hook (`.claude/hooks/session-start.sh`, wired by `.claude/settings.json`) provisions the local database, runs migrations, and installs Playwright Chromium so web sessions can build and test immediately.

For Vercel-backed local envs, run `vercel login`, approve the device-login URL, confirm `.vercel/project.json` links to the Chloei Labs `chloei` project, then `vercel env pull .env.local --yes`.

## Architecture

### Request Flow

```
Client (useAgentSession)
  → POST /api/agent (app/api/agent/route.ts)
    → Auth check (isAuthConfigured → getRequestSession)   [routes self-guard; see Middleware]
    → Zod validation (parseAgentStreamRequest) — model + messages
    → System prompt assembly (buildAgentSystemInstruction)
    → OpenAI Agents SDK stream (startGatewayResponseStream → startAgentRuntimeStream → run())
    → NDJSON chunks (application/x-ndjson) → client
      → readResponseStreamLines / parseStreamEventLine
        → applyAgentStreamEvent → AgentStreamAccumulator → React state → render
  → Thread upsert (useThreadStore → PUT /api/threads → upsertThreadForUser → PostgreSQL JSONB)
```

Key route files: `src/app/api/agent/route.ts` (HTTP entry, auth, validation) → `src/lib/server/agent-route.ts` (`parseAgentStreamRequest`, `createAgentStreamResponse`, NDJSON writing, fallback handling) → `src/lib/server/llm/agent-runtime.ts` (the tool loop) → `src/lib/server/llm/gateway-responses.ts` (`startGatewayResponseStream`).

Before the model sees them, messages pass through `toModelMessages` (`agent-runtime-messages.ts`). System-role messages are rejected there — system content must come via `systemInstruction`.

### Server / Client / Shared Boundary

- `src/lib/server/` — server-only. Never import from client components.
- `src/lib/shared/` — isomorphic. Safe to import anywhere.
- `src/lib/actions/` — Next.js server actions; callable from client.
- `src/components/` — client components and hooks.

This boundary is **enforced by Next.js bundling at build time** (importing `pg`/`better-auth`/server modules into a client bundle is a build error), **not** by an ESLint rule. Keep it in mind when adding imports.

### System Prompt Composition

`buildAgentSystemInstruction` (`src/lib/server/agent-context.ts`) assembles the prompt per-request from labeled blocks delimited by `--- BEGIN <LABEL> ---` / `--- END <LABEL> ---`. Blocks are ordered **stable → volatile** so the longest possible prompt **prefix** stays byte-identical across requests, which is what OpenAI prompt caching keys on:

1. `OPERATING INSTRUCTIONS` — `DEFAULT_OPERATING_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
2. **Provider overlay** (`PROVIDER OVERLAY: ALIBABA|ANTHROPIC|MOONSHOTAI|OPENAI|ZAI`) — keyed by the model's **provider org**, not its nickname. `agent-prompt-steering.ts` defines overlays for `alibaba`, `anthropic`, `moonshotai`, `openai`, and `zai`; only `openai` is wired today. Always applied for a supported model.
3. `IDENTITY AND TONE CONTEXT` — `DEFAULT_SOUL_FALLBACK_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
4. `AUTH USER CONTEXT` — authenticated user id, name, email (per-user, semi-stable)
5. `RUNTIME DATE CONTEXT` — current UTC timestamp + user timezone (from `X-User-Timezone` header). **Last on purpose** — it embeds the current timestamp, so keeping it ahead of the stable blocks would bust the cacheable prefix.

Inline-citation rules are appended **later**, by `withAiSdkInlineCitationInstruction` (`system-instruction-augmentations.ts`), inside `createAgentStreamResponse` — not by `buildAgentSystemInstruction`.

**Prompt caching** (`agent-runtime.ts` `resolvePromptCacheSettings`): every run sets a `prompt_cache_key` (via `modelSettings.providerData`) to co-locate identical prefixes — `"chloei-agent"`. GPT-5.6 Sol paths also set `promptCacheRetention: "24h"`. Token usage (`result.state.usage`, incl. `inputTokensDetails.cached_tokens`) is logged on stream finish via `summarizeRunUsage`.

### Streaming Protocol

`/api/agent` returns `Content-Type: application/x-ndjson`. Each line is a JSON-encoded `AgentStreamEvent` (`src/lib/shared/agent/messages.ts`). The client reads line-by-line in `readResponseStreamLines` and feeds events through `applyAgentStreamEvent` into an `AgentStreamAccumulator`.

Event types:

- `text_delta` — incremental assistant text
- `reasoning_delta` — incremental reasoning text (sanitized + redacted-placeholder-filtered; see below)
- `agent_status` — `in_progress | completed | failed | cancelled | incomplete`
- `tool_call` — tool start: `callId`, `toolName`, `label`, plus optional `query`, `operation`, `provider`
- `tool_result` — tool result: `callId`, `status: success | error`, plus optional `operation`, `provider`, `durationMs`, `errorCode`, `retryable`
- `source` — citation source: `id`, `url`, `title`

Every event also carries optional `interactionId` and `lastEventId` checkpoint fields.

The client accumulator (`agent-stream-state.ts`) builds: `content`, `reasoning`, `toolInvocations`, `activityTimeline` (kinds: `tool`, `search`, `sources`, `reasoning`), and `sources` (deduped by URL).

### Synthesis Gating and Fallbacks

The runtime actively prevents "ran tools but never wrote an answer" outcomes (`agent-runtime.ts` + `agent-runtime-synthesis-gating.ts`):

- **Tool budget** — `run()` is capped with `maxTurns: AGENT_TOOL_MAX_STEPS`; a `MaxTurnsExceededError` is caught and routed into the final-synthesis pass below (the Agents SDK has no per-step `prepareStep`).
- **Mid-budget nudge** — baked into the agent instructions (always-on), since per-step system overrides aren't available; it reminds the model to stop retrieving and synthesize.
- **Final-synthesis / empty-response fallback** — if the main run ends with zero emitted text (and wasn't aborted), a second `run()` with **no tools** and a hard "write the answer now" instruction, fed the gathered run history (`result.history`), forces a written answer.

`createAgentStreamResponse` also injects fallback text and downgrades `agent_status` to `incomplete` on timeout, provider-auth errors (401/403/`invalid_api_key` → "Invalid OPENAI_API_KEY"), or empty output. Responses set `X-Agent-Effective-Model` and `Cache-Control: no-store, no-transform`.

### Reasoning and Privacy

Streamed reasoning is filtered through three layers so the hidden prompt never leaks:

1. Literal `[REDACTED]` reasoning chunks are dropped (`initial-reasoning-chunk-sanitizer.ts`).
2. Leading `thinking:` / `reasoning:` labels are stripped (buffered across chunk boundaries).
3. `sanitizeReasoningForDisplay` (`src/lib/shared/agent/reasoning-privacy.ts`) redacts prompt-internal terms (`soul.md`, "system prompt", "operating instructions", "provider overlay", "auth user context", etc.). `getPrivateReasoningCarryLength` holds back a trailing partial token across chunk boundaries so a split secret can't slip through. Applied both at stream time and on thread persistence.

User ids are never logged in the clear: `hashUserId` (`src/lib/server/privacy.ts`) produces a `sha256:<hex>` digest used for telemetry user-hashing.

### Agent Tools

The only tools are the two Exa web-search tools, and both are registered together when `EXA_API_KEY` is set. There are no other internal or external tools.

| Tool               | Requirement   | Tool id / operations                                                                                                                                           |
| ------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exa_search`       | `EXA_API_KEY` | Web search. `category: news\|company\|research paper\|pdf\|financial report`, `timeRange`, `includeDomains`, `excludeDomains`; up to **8** results (default 5) |
| `exa_get_contents` | `EXA_API_KEY` | Read full page content from up to **5** URLs                                                                                                                   |

**Max tool steps** (`AGENT_TOOL_MAX_STEPS` in `agent-runtime-config.ts`): 12.

### Model Registry

All models are defined in `src/lib/shared/llm/models.ts`:

| Key                    | Model ID        | Display Name  |
| ---------------------- | --------------- | ------------- |
| `OPENAI_GPT_5_6_SOL`   | `gpt-5.6-sol`   | GPT-5.6 Sol   |
| `OPENAI_GPT_5_6_TERRA` | `gpt-5.6-terra` | GPT-5.6 Terra |
| `OPENAI_GPT_5_6_LUNA`  | `gpt-5.6-luna`  | GPT-5.6 Luna  |

- `MODEL_SELECTOR_MODELS` — the chat selector subset, rendered as a dropdown at the top-left of the home page (`model-selector.tsx`). **Order matters: the first entry (GPT-5.6 Sol) is the default.** The selection persists in `localStorage` and syncs across components via the `model-selector-updated` event.
- The agent accepts **multimodal input**: plain text plus image (`image/png|jpeg|webp|gif`) and PDF (`application/pdf`) attachments for vision / document analysis. Attachments are added via the paperclip button in the prompt form and sent as base64 data URLs the **first** time (`attachments[]` in `agentMessageSchema`). **Files-API round-trip:** before streaming, the route uploads each new base64 attachment once via the OpenAI Files API (`resolveAttachmentFileIds` in `src/lib/server/llm/attachment-uploads.ts`; images use `purpose: "vision"`, PDFs `"user_data"`), sets its `fileId`, and echoes a `{ attachmentId: fileId }` map in the `X-Attachment-File-Ids` response header. The client (`use-agent-session.ts`) stores the `fileId` on the message and, on later turns, resends the `fileId` instead of the base64 (`toRequestMessages`). `toAgentInputItems` (`agent-runtime-messages.ts`) references the file by `{ id: fileId }` (falling back to the inline base64 url). Net effect: each file is uploaded once and stays prompt-cacheable across turns. Limits live in `src/lib/shared/agent-request-limits.ts` (≤5 files/message, ≤10 MB each); the request body cap is `proxyClientMaxBodySize` in `next.config.mjs`. On persistence the base64 `url` is **stripped** but the `fileId` is **kept** (`thread-payload.ts` `messageAttachmentSchema`), so a reloaded thread can still resend the file by id.
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

`app-migrate.mjs` backfills `title` and drops legacy tables/columns (including the former `agent_rate_limit`).

**Pinning is client-side only** — there is no server column. Pinned thread ids live in `localStorage` (`chloei:pinned-thread-ids`, `src/components/nav-threads.tsx`) and pinned-first ordering happens in the sidebar render, not in the API.

**Thread API** (`/api/threads`):

- `GET` (no query) — returns lightweight `ThreadSummary[]` (id, title, model, timestamps; **no messages**), newest-first.
- `GET ?id=<threadId>` — returns the full `Thread` (with messages).
- `PUT` — upsert a full `Thread`.
- `DELETE` — delete by id (body `{ id }`); responds `204 No Content`.

**Client thread store** (`src/components/agent/home/use-thread-store.ts` via `ThreadStoreProvider`) — a bespoke `useState`/refs store (not React Query). It holds `threadSummaries` (the list), lazily-hydrated full `threads`, and `currentThreadId`. Writes go through `saveThread`: optimistic local merge, then an immediate or 800 ms-debounced `PUT`, with 3 s retry, per-thread `AbortController` dedupe, and `updatedAt` stale-write protection. The available-model list is resolved once on the server (`getModels()` in `page.tsx`) and read from a `ModelsProvider` context (`src/hooks/agent/use-models.tsx`) — there is no client-side data-fetching library.

### Rate Limiting

The agent endpoints (`/api/agent`, `/api/agent/follow-ups`) are **not** rate-limited.

**Better Auth has its own credential-route limits** (`src/lib/server/auth.ts`, `rateLimit`): ~100 req / 10 s globally, with `/sign-in/email` and `/sign-up/email` capped at 5 req / 15 min — brute-force protection on authentication.

### Authentication and Middleware

Better Auth handles sessions. `getRequestSession` (`src/lib/server/auth-session.ts`) reads the session from request headers. `isAuthConfigured()` returns false when `DATABASE_URL`/`BETTER_AUTH_SECRET` are missing — routes then return 503 rather than crashing. On Vercel, `BETTER_AUTH_URL` can be inferred from `VERCEL_URL`/`VERCEL_BRANCH_URL`/`VERCEL_PROJECT_PRODUCTION_URL`, so `isAuthConfigured()` can be true without an explicit `BETTER_AUTH_URL`.

**Middleware** (`src/proxy.ts`) — exported as a **named** `proxy` function plus `config` (not a default export):

- **Matcher is only `["/", "/sign-in", "/sign-up"]`.** It does **not** match `/api/*`. API routes are guarded by their own in-route `isAuthConfigured()` / `getRequestSession()` checks, not by middleware.
- `/api/auth/*` is passed through unconditionally (when matched).
- Auth not configured → allow auth pages, 503 on API, redirect elsewhere to `/sign-in`.
- Authenticated → redirect auth pages home (or the `redirect` query path).
- Not authenticated → redirect to `/sign-in`.
- **Fail-open**: if `getRequestSession` throws, the middleware logs and calls `next()` (lets the request through).

### Feature Flags

`src/lib/server/integration-flags.ts` resolves default-off flags: `telemetryRecordIo` (`AGENT_TELEMETRY_RECORD_IO`), `responseCompaction` (`AGENT_RESPONSE_COMPACTION` — enables OpenAI server-side context compaction within a run via `modelSettings.contextManagement`; `resolveContextManagementSettings` in `agent-runtime.ts`, threshold `RESPONSE_COMPACTION_TOKEN_THRESHOLD`), and `responsesWebsocketTransport` (`AGENT_RESPONSES_WS_TRANSPORT` — routes Responses API traffic over a persistent WebSocket via `configureResponsesTransport` in `openai-client.ts` instead of HTTP). Precedence:

1. Explicit `AGENT_*` env var (e.g. `AGENT_TELEMETRY_RECORD_IO`).
2. Edge Config (`EDGE_CONFIG`) — checked across three map namespaces in order: **`agent_flags`, `analytics_flags`, `flags`**, matching the dotted key (e.g. `agent.telemetry.record_io`) or its Vercel slug form (e.g. `agent-telemetry-record-io`), then top-level fallback keys.
3. Built-in default (off).

### Background, Webhooks & Transport (run & scale)

Foundations for disconnect-resilient long runs. The raw OpenAI client (Files API, webhooks, background responses — endpoints the Agents SDK doesn't wrap) lives in `src/lib/server/llm/openai-raw-client.ts` (`getOpenAiClient`).

- **WebSocket transport** — flag-gated (`responsesWebsocketTransport`); see Feature Flags above.
- **Webhook receiver** — `POST /api/webhooks/openai` (`src/app/api/webhooks/openai/route.ts`) verifies the Standard-Webhooks signature via `client.webhooks.unwrap` (secret `OPENAI_WEBHOOK_SECRET`; unset → 503; bad signature → 400), de-dupes by webhook id, and acks 2xx. The signing secret is the auth — the route is intentionally public (the middleware matcher doesn't cover `/api/*`). Register the endpoint + secret in the OpenAI dashboard.
- **Background + resumable streaming** — `src/lib/server/llm/background-responses.ts`: `createBackgroundResponse` (`background: true, store: true`) returns an id immediately; `resumeBackgroundResponseStream` streams a stored response from a `starting_after` checkpoint. `GET /api/agent/responses/[responseId]/stream?after=<seq>` resumes as NDJSON. **Not yet wired to the agent loop** — running the tool-using SDK loop in the background needs a worker (serverless functions end with the response), which is the remaining piece; nothing creates background agent runs today.

### Observability and Telemetry

- **Logging**: `createLogger(scope)` (`src/lib/logger.ts`) returns `{ info, warn, error }`. In production (`NODE_ENV=production`) it emits newline-delimited JSON with structured fields (always `level`, `message`, `scope`, `timestamp`; when present `requestId`, `errorCode`, `durationMs`, `method`, `model`, `outcome`, `route`, `status`, plus Vercel deployment metadata). In dev it falls back to human-readable `[scope] message`.
- **Route observability**: all API routes use `createRouteObservation` / `observeRouteResponse` (`src/lib/server/route-observability.ts`) to log duration, outcome, and error codes.
- **Product analytics**: `@vercel/analytics` and `@vercel/speed-insights` are mounted in the root layout (`src/app/layout.tsx`).
- **There is no Sentry, PostHog, or OpenTelemetry** — those integrations were removed. Error tracking is via Vercel runtime logs (the structured JSON above). Do not reintroduce them without an explicit decision.

### Integrations

- **Feature flags** — see the dedicated section above.

## File Structure

```
src/
  app/
    (auth)/             # Sign-in / sign-up pages (route group)
    (home)/             # Main app — wraps children in ThreadStoreProvider
      page.tsx          #   server component: auth-guards, getModels(), seeds RQ cache
    api/
      agent/route.ts       # POST /api/agent — streaming agent endpoint
      agent/follow-ups/    # Follow-up question suggestions
      agent/responses/[responseId]/stream/  # GET — resume a stored background response (starting_after)
      auth/[...all]/       # Better Auth catch-all
      models/route.ts      # GET /api/models — available models for configured keys
      threads/route.ts     # GET/PUT/DELETE /api/threads — thread CRUD
      webhooks/openai/     # POST — OpenAI webhook receiver (signature-verified)
    layout.tsx          # Root layout: fonts, dark theme, Analytics + SpeedInsights, dev cache-reset
    manifest.ts         # PWA manifest (production-only standalone)
  components/
    agent/home/         # Chat core: use-agent-session, agent-stream-state/-events,
                        #   thread-store-context, use-thread-store, home-content,
                        #   follow-up-questions
    agent/messages/     # Message rendering (user, assistant, queued, activity timeline)
    agent/markdown/     # Memoized markdown renderer
    agent/prompt-form/  # PromptForm, ModelSelector
    app-sidebar.tsx     # Sidebar shell (lazy-loads SearchChats + NavThreads)
    nav-threads.tsx     # Thread list + client-side pinning (localStorage)
    nav-user.tsx        # Account menu + sign-out
    search-chats.tsx    # Client-side thread title search dialog
    auth/               # Sign-in/up forms, auth shell
    graphics/           # Logo + visual effects
    layout/             # route group layout
    ui/                 # shadcn/ui primitives (base-maia/neutral) + ShikiCode
  hooks/
    agent/              # use-models (server-seeded models context),
                        #   use-persistent-selected-model (localStorage-backed)
  lib/
    actions/api-keys.ts # getModels() server action
    brand/colors.ts     # App brand colors (used by layout/manifest)
    editor/highlighter.ts
    server/
      agent-context.ts          # buildAgentSystemInstruction
      agent-prompt-steering.ts  # Provider overlays (per-provider tuning; anthropic/Claude today)
      agent-route.ts            # parseAgentStreamRequest, createAgentStreamResponse
      agent-runtime-config.ts   # Runtime constants (no env knobs)
      auth.ts / auth-session.ts # isAuthConfigured, getRequestSession
      integration-flags.ts      # Default-off feature flags (env + Edge Config)
      privacy.ts                # hashUserId (telemetry user hashing)
      route-observability.ts    # createRouteObservation, observeRouteResponse
      threads.ts / thread-payload.ts  # Thread CRUD + Zod parsing
      postgres.ts               # getDatabase() Kysely instance
      llm/
        agent-runtime.ts                  # Core tool-loop orchestration
        agent-runtime-messages.ts         # Message preparation (rejects system-role)
        agent-runtime-synthesis-gating.ts # Final-step + mid-budget synthesis predicates
        gateway-responses.ts              # startGatewayResponseStream
        openai-client.ts                  # configures OpenAI Agents SDK (key + tracing off)
        openai-agents-exa-tools.ts        # exa_search / exa_get_contents
        initial-reasoning-chunk-sanitizer.ts # Redacted-reasoning filtering
        system-instruction-augmentations.ts  # Citation rules appended to prompt
    shared/
      agent/messages.ts          # AgentStreamEvent, Message, ToolInvocation, run statuses
      agent/reasoning-privacy.ts # sanitizeReasoningForDisplay
      agent-request-limits.ts    # Message/char limit defaults
      llm/models.ts              # AvailableModels, ModelInfos, SUPPORTED/SELECTOR/RESEARCH
      llm/system-instructions.ts # DEFAULT_OPERATING_INSTRUCTION, DEFAULT_SOUL_FALLBACK_INSTRUCTION
      threads.ts                 # Thread type, sort/normalize/deriveThreadTitle
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
- Stubs in `tests/stubs/` mock server-only modules (postgres, auth-session, …) so tests run without a database.
- `tests/register-ts-path-hooks.mjs` wires `@/` path resolution and supports per-test module stub injection (`setTestModuleStubs`).
- Smoke: `tests/smoke/mock-authenticated-chat.spec.mjs` is credential-free (used by CI); `authenticated-chat.spec.mjs` needs `SMOKE_EMAIL`/`SMOKE_PASSWORD`.

## Key Conventions

**TypeScript**: strict mode + `noUncheckedIndexedAccess` (every array index access must handle `undefined`). Target ES2022, module resolution Bundler. Path alias `@/*` → `src/*`.

**Named exports only** — default exports are allowed only in `src/app/**` (Next.js page/layout/route files) and `src/types/assets.d.ts`. Enforced via an ESLint `no-restricted-syntax` rule on `ExportDefaultDeclaration`.

**ESLint** (type-checked configs on `src/**` + `auth.ts`): beyond `simple-import-sort`, notable error-level rules include `no-console` (warn/error allowed), `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, and `consistent-type-imports` (inline `import type`). `reportUnusedDisableDirectives` is on. Run `pnpm lint:fix` to auto-sort imports.

**Prettier**: `semi: false`, double quotes, `tabWidth: 2`, `printWidth: 80`, `trailingComma: es5`. Only `prettier-plugin-tailwindcss` is configured (`tailwindFunctions: ["cn", "cva"]`); import sorting is ESLint's job, not Prettier's.

**API error shape**: all errors return `{ error, errorCode }` with `X-Request-Id` and `X-Error-Code` headers.

**Zod v4** (`zod@^4`): API differs from v3 (`.strict()` behavior, `z.iso.datetime()`, error formatting).

**Stack**: React 19, Next.js 16.2.9, Node `24.x`, pnpm `10.32.1`. Client components use `"use client"` by directory convention. UI is shadcn/ui (`base-maia` style, `neutral` base color, lucide icons; see `components.json`).

**Bundle budget**: `pnpm bundle:budget` fails if total `.next/static` JS exceeds 14 MiB or any single chunk exceeds 1 MiB (overridable via `BUNDLE_MAX_STATIC_CHUNKS_BYTES` / `BUNDLE_MAX_STATIC_CHUNK_BYTES`). CI runs both `bundle:budget` and `bundle:report`.

**Security headers** (`next.config.mjs`): applied to every route — `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-DNS-Prefetch-Control: on`, `Cross-Origin-Opener-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, plus `poweredByHeader: false`. **Production-only**: HSTS (`max-age=63072000; includeSubDomains; preload`) and the Content-Security-Policy. The CSP allows `'unsafe-inline'` for `script-src`/`style-src` (required by Next.js's inline runtime), so it is not nonce-strict.

**CI** (`.github/workflows/ci.yml`): a `checks` job (lint → format:check → test → typecheck → build → bundle:budget → bundle:report), a separate `smoke` job in the Playwright image, and a `vercel-status` job that aggregates both into a single `Vercel` commit status. Vercel build runs `pnpm migrate && pnpm build`; `scripts/vercel-ignore-build.mjs` skips builds for docs/tooling-only diffs.

## Environment Variables

Required for a working local instance:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
OPENAI_API_KEY=
```

All others are optional with safe defaults. See `.env.example` for the annotated list.

| Variable                       | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `AUTH_DATABASE_URL`            | Separate DB for Better Auth (falls back to / reuses `DATABASE_URL`)            |
| `BETTER_AUTH_TRUSTED_ORIGINS`  | Comma-separated additional trusted origins                                     |
| `BETTER_AUTH_COOKIE_DOMAIN`    | Shared cookie domain for cross-subdomain auth                                  |
| `EXA_API_KEY`                  | Enables `exa_search` + `exa_get_contents`                                      |
| `EDGE_CONFIG`                  | Vercel Edge Config connection for remote feature flags                         |
| `OPENAI_WEBHOOK_SECRET`        | Signing secret for the `/api/webhooks/openai` receiver (unset → 503)           |
| `AGENT_TELEMETRY_RECORD_IO`    | Feature flag: record prompt/output IO in telemetry (default off)               |
| `AGENT_RESPONSE_COMPACTION`    | Feature flag: OpenAI server-side context compaction within a run (default off) |
| `AGENT_RESPONSES_WS_TRANSPORT` | Feature flag: WebSocket transport for the Responses API (default off)          |

Request size limits, stream/gateway timeouts, tool-step budgets, and body-size limits are **fixed constants** in `src/lib/server/agent-runtime-config.ts` / `next.config.mjs` — not env-configurable. Change them in code if needed.

## Gotchas

- **Run `pnpm migrate` before the first request.** Storage does not self-initialize on live requests; uninitialized tables surface as a 500 with a migration message.
- **`pnpm test` is unit-only.** Smoke tests need a prior production build (`pnpm test:smoke:mock:build`).
- The **mock smoke test uses the production server** (`next start`), so build first.
- `pnpm.onlyBuiltDependencies` already approves the `sharp` build script — do not run `pnpm approve-builds`.
- Don't reintroduce Sentry/PostHog/OpenTelemetry; they were intentionally removed in favor of Vercel Analytics/Speed Insights + structured logs.
- Pinning and selected model are **client-side localStorage** — there are no server columns or APIs for them.
- After signing up via `/api/auth/sign-up/email`, the session cookie is set automatically; no separate sign-in is needed.
